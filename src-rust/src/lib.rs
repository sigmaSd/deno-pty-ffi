use crossbeam::channel::{unbounded, Receiver, Sender};
use portable_pty::{native_pty_system, CommandBuilder, PtySize, SlavePty};
use serde::{Deserialize, Serialize};
use std::{
    ffi::{CStr, CString},
    io::Read,
    mem::ManuallyDrop,
};
mod utils;
use utils::cstr_to_type;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub struct Pty {
    reader: PtyReader,
    tx_write: Sender<String>,
    // keep the slave alive
    // so windows works
    // https://github.com/wez/wezterm/issues/4206
    _slave: Box<dyn SlavePty + Send>,
}

#[derive(Clone)]
struct PtyReader {
    rx_read: Receiver<Message>,
}
impl PtyReader {
    fn new(rx_read: Receiver<Message>) -> PtyReader {
        Self { rx_read }
    }
    fn read(&self) -> Result<Message> {
        //NOTE: important, block until we read something
        // then check the channel for any more available msg
        // this saves a lot of read calls
        let msgs: Vec<_> = std::iter::once(self.rx_read.recv()?)
            .chain(self.rx_read.try_iter())
            .collect();

        // NOTE: we might have some msgs here
        // it might be better to tell the user about them
        if msgs.contains(&Message::End) {
            return Ok(Message::End);
        }
        let msg = msgs
            .iter()
            .map(|msg| {
                if let Message::Data(data) = msg {
                    return data.as_str();
                } else {
                    ""
                }
            })
            .collect::<Vec<_>>()
            .join("");

        Ok(Message::Data(msg))
    }
}

#[derive(Serialize, Deserialize)]
struct Command {
    cmd: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
}

#[derive(PartialEq, Eq)]
enum Message {
    Data(String),
    End,
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

        let (tx_read, rx_read) = unbounded();

        let mut child = pair.slave.spawn_command(cmd)?;

        // If we do a pty.read after the process exit, read will hang
        // Thats why we spawn another thread to wait for the child
        // and signal its exit
        let tx_read_c = tx_read.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            let _ = tx_read_c.send(Message::End);
        });

        // Read the output in another thread.
        // This is important because it is easy to encounter a situation
        // where read/write buffers fill and block either your process
        // or the spawned process.
        let mut reader = pair.master.try_clone_reader()?;
        std::thread::spawn(move || {
            let mut buf = [0; 512];
            loop {
                let n = reader.read(&mut buf).expect("failed to read data");
                // ignore send error, it errors when the recevier closes
                let _ = tx_read.send(Message::Data(
                    String::from_utf8(buf[0..n].to_vec()).expect("data is not valid utf8"),
                ));
            }
        });

        let mut writer = pair.master.take_writer()?;
        let (tx_write, rx_write): (Sender<String>, _) = unbounded();
        std::thread::spawn(move || {
            while let Ok(buf) = rx_write.recv() {
                writer
                    .write_all(&buf.into_bytes())
                    .expect("failed to write data");
            }
        });

        Ok(Self {
            reader: PtyReader::new(rx_read),
            tx_write,
            _slave: pair.slave,
        })
    }

    #[allow(dead_code)]
    fn clone_reader(&self) -> PtyReader {
        self.reader.clone()
    }

    fn read(&self) -> Result<Message> {
        self.reader.read()
    }

    fn write(&self, data: String) -> Result<()> {
        Ok(self.tx_write.send(data)?)
    }
}

// note: need to be careful with names with no_mangle extern C
// for example extern C write, will cause weird bugs

/// # Safety
/// - Requires a valid pointer to a Command
/// - Requires a valid pointer to a buffer of size 8
/// to write the result to
///
/// Returns -1 on error
#[no_mangle]
// can't use new since its a reserved keyword in javascript
pub unsafe extern "C" fn pty_create(command: *mut i8, result: *mut usize) -> i8 {
    let pty = (|| -> Result<Box<Pty>> {
        let command = cstr_to_type::<Command>(command)?;
        let pty = Pty::create(command)?;
        Ok(Box::new(pty))
    })();
    match pty {
        Ok(pty) => {
            *result = Box::into_raw(pty) as usize;
            0
        }
        Err(err) => {
            *result = CString::new(err.to_string())
                .expect("err is valid cstring")
                .into_raw() as _;
            -1
        }
    }
}

/// # Safety
/// - Requires a valid pointer to a Pty
/// - Requires a valid pointer to a buffer of size 8
/// to write the result to
///
/// Returns -1 on error
/// Returns 99 on process exit
#[no_mangle]
pub unsafe extern "C" fn pty_read(this: *mut Pty, result: *mut usize) -> i8 {
    enum R {
        Data(CString),
        End,
    }
    match (|| -> Result<R> {
        let this = ManuallyDrop::new(Box::from_raw(this));
        // TODO: add a test for null byte inside str from read
        let msg = this.read()?;
        match msg {
            Message::Data(data) => Ok(R::Data(CString::new(data.replace('\0', ""))?)),
            Message::End => Ok(R::End),
        }
    })() {
        Ok(data) => match data {
            R::Data(str) => {
                *result = str.into_raw() as _;
                0
            }
            R::End => 99,
        },
        Err(err) => {
            *result = CString::new(err.to_string())
                .expect("err is valid cstring")
                .into_raw() as _;
            -1
        }
    }
}

/// # Safety
/// - Requires a valid pointer to a Pty
/// - Requires a valid pointer to data encoded as Cstring
/// - Requires a valid pointer to a buffer of size 8
/// to write the result to
///
/// Returns -1 on error
#[no_mangle]
pub unsafe extern "C" fn pty_write(this: *mut Pty, data: *mut i8, result: *mut usize) -> i8 {
    fn inner(this: &Pty, data: &CStr) -> Result<()> {
        let data_str = data.to_str()?.to_owned(); // NOTE: can we send str in the channels ?
        this.write(data_str)
    }

    let this = ManuallyDrop::new(Box::from_raw(this));
    let data = ManuallyDrop::new(CString::from_raw(data));
    match inner(&this, data.as_ref()) {
        Ok(_) => 0,
        Err(err) => {
            *result = CString::new(err.to_string())
                .expect("err is valid cstring")
                .into_raw() as _;
            -1
        }
    }
}

/// # Safety
/// Requires a pointer to a buffer of size 8 to write the result to
///
/// The result is either
/// - tmpDir as cstring
/// - error as cstring
///
/// Returns -1 on error
#[no_mangle]
pub unsafe extern "C" fn tmp_dir(result: *mut usize) -> i8 {
    fn inner() -> Result<CString> {
        Ok(CString::new(
            std::env::temp_dir()
                .to_str()
                .ok_or("path is not valid utf8?")?
                .to_owned(),
        )?)
    }

    match inner() {
        Ok(data) => {
            *result = data.into_raw() as _;
            0
        }
        Err(err) => {
            *result = CString::new(err.to_string())
                .expect("err is valid cstring")
                .into_raw() as _;
            -1
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;
    #[test]
    fn it_works() {
        let pty = Box::new(
            Pty::create(Command {
                cmd: "deno".into(),
                args: vec!["repl".into()],
                env: vec![("NO_COLOR".into(), "1".into())],
            })
            .unwrap(),
        );

        // read header
        pty.read().unwrap();

        let write_and_expect = |to_write: &'static str, expect: &'static str| {
            pty.write(to_write.into()).unwrap();

            let (tx, rx) = mpsc::channel();
            let tx_c = tx.clone();
            let reader = pty.clone_reader();
            std::thread::spawn(move || loop {
                let r = reader.read().unwrap();
                match r {
                    Message::Data(data) => {
                        if data.contains(expect) {
                            tx.send(Ok(())).unwrap();
                            break;
                        }
                    }
                    Message::End => break,
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
