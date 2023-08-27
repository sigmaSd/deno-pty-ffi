use parking_lot::{Mutex, MutexGuard};
use portable_pty::{native_pty_system, CommandBuilder, PtySize, SlavePty};
use serde::{Deserialize, Serialize};
use std::{
    ffi::{CStr, CString},
    mem::ManuallyDrop,
    sync::{
        mpsc::{Receiver, Sender},
        Arc,
    },
};
mod utils;
use utils::cstr_to_type;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub struct Pty {
    rx_read: Receiver<String>,
    tx_write: Sender<String>,
    // keep the slave alive
    // so windows works
    // https://github.com/wez/wezterm/issues/4206
    _slave: Box<dyn SlavePty + Send>,
}

#[derive(Serialize, Deserialize)]
struct Command {
    cmd: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
}

impl Pty {
    fn create(command: Command) -> Result<Self> {
        // Use the native pty implementation for the system
        let pty_system = native_pty_system();

        // Create a new pty
        let pair = pty_system.openpty(PtySize {
            rows: 24,
            cols: 80,
            // Not all systems support pixel_width, pixel_height,
            // but it is good practice to set it to something
            // that matches the size of the selected font.  That
            // is more complex than can be shown here in this
            // brief example though!
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new(command.cmd);
        // https://github.com/wez/wezterm/issues/4205
        cmd.env("PATH", std::env::var("PATH")?);
        cmd.args(&command.args);
        cmd.cwd(std::env::current_dir()?);
        for env in command.env {
            cmd.env(env.0, env.1);
        }

        let _child = pair.slave.spawn_command(cmd)?;
        let slave = pair.slave;

        // Read the output in another thread.
        // This is important because it is easy to encounter a situation
        // where read/write buffers fill and block either your process
        // or the spawned process.
        let (tx_read, rx_read) = std::sync::mpsc::channel();
        let mut reader = pair.master.try_clone_reader()?;
        std::thread::spawn(move || {
            let mut buf = [0; 512];
            loop {
                let n = reader.read(&mut buf).expect("failed to read data");
                // ignore send error, it errors when the recevier closes
                let _ = tx_read
                    .send(String::from_utf8(buf[0..n].to_vec()).expect("data is not valid utf8"));
            }
        });

        let mut writer = pair.master.take_writer()?;
        let (tx_write, rx_write): (Sender<String>, _) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            while let Ok(buf) = rx_write.recv() {
                writer
                    .write_all(&buf.into_bytes())
                    .expect("failed to write data");
            }
        });

        Ok(Self {
            rx_read,
            tx_write,
            _slave: slave,
        })
    }

    fn read(&self) -> Result<String> {
        Ok(self.rx_read.recv()?)
    }

    fn write(&self, data: String) -> Result<()> {
        Ok(self.tx_write.send(data)?)
    }
}

// note: need to be careful with names with no_mangle extern C
// for example extern C write, will cause weird bugs

#[no_mangle]
// can't use new since its a reserved keyword in javascript
/// # Safety
/// needs a valid pointer to a Command
pub unsafe extern "C" fn pty_create(command: *mut i8) -> *const Mutex<Pty> {
    fn inner(command: Command) -> Result<Arc<Mutex<Pty>>> {
        let pty = Pty::create(command)?;
        Ok(Arc::new(Mutex::new(pty)))
    }

    let Ok(command) = cstr_to_type::<Command>(command) else {
        return std::ptr::null();
    };
    if let Ok(result) = inner(command) {
        Arc::into_raw(result)
    } else {
        std::ptr::null()
    }
}

#[no_mangle]
/// # Safety
/// needs a valid pointer to a Pty
pub unsafe extern "C" fn pty_read(this: *const Mutex<Pty>) -> *mut i8 {
    fn inner(this: MutexGuard<Pty>) -> Result<CString> {
        Ok(CString::new(this.read()?)?)
    }

    let this = ManuallyDrop::new(Arc::from_raw(this));
    let this = this.lock();
    if let Ok(result) = inner(this) {
        result.into_raw()
    } else {
        std::ptr::null_mut()
    }
}

#[no_mangle]
/// returns -1 on failure
/// # Safety
/// needs a valid pointer to a Pty and a CString
pub unsafe extern "C" fn pty_write(this: *const Mutex<Pty>, data: *mut i8) -> i8 {
    fn inner(this: MutexGuard<Pty>, data: &CStr) -> Result<()> {
        let data_str = data.to_str()?.to_owned(); // NOTE: can we send str in the channels ?
        this.write(data_str)
    }

    let this = ManuallyDrop::new(Arc::from_raw(this));
    let this = this.lock();
    let data = ManuallyDrop::new(CString::from_raw(data));
    if let Ok(_result) = inner(this, data.as_ref()) {
        0
    } else {
        -1
    }
}

#[no_mangle]
pub extern "C" fn tmp_dir() -> *mut i8 {
    fn inner() -> Result<CString> {
        Ok(CString::new(
            std::env::temp_dir()
                .to_str()
                .ok_or("path is not valid utf8?")?
                .to_owned(),
        )?)
    }

    if let Ok(result) = inner() {
        result.into_raw()
    } else {
        std::ptr::null_mut()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;
    #[test]
    fn it_works() {
        let pty = Arc::new(Mutex::new(
            Pty::create(Command {
                cmd: "deno".into(),
                args: vec!["repl".into()],
                env: vec![("NO_COLOR".into(), "1".into())],
            })
            .unwrap(),
        ));

        // read header
        pty.lock().read().unwrap();

        let write_and_expect = |to_write: &'static str, expect: &'static str| {
            pty.lock().write(to_write.into()).unwrap();

            let (tx, rx) = mpsc::channel();
            let tx_c = tx.clone();
            let pty_c = pty.clone();
            std::thread::spawn(move || loop {
                let r = pty_c.lock().read().unwrap();
                if r.contains(expect) {
                    tx.send(Ok(())).unwrap();
                    break;
                }
            });
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                tx_c.send(Err("timeout")).unwrap();
            });
            let r = rx.recv().unwrap();
            if let Err(e) = r {
                panic!("{e}");
            }
        };

        write_and_expect("5+4\n\r", "9");
        write_and_expect("let a = 4; a + a\n\r", "8");
    }
}
