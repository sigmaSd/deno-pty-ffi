use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    ffi::CString,
    mem::ManuallyDrop,
    sync::{
        mpsc::{Receiver, Sender},
        Arc, Mutex,
    },
};
mod utils;
use utils::cstr_to_type;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub struct Pty {
    rx_read: Receiver<String>,
    tx_write: Sender<String>,
}

#[derive(Serialize, Deserialize)]
struct Command {
    cmd: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
}

impl Pty {
    fn new(command: Command) -> Result<Self> {
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
        cmd.args(&command.args);
        cmd.cwd(std::env::current_dir().unwrap());
        for env in command.env {
            cmd.env(env.0, env.1);
        }

        let _child = pair.slave.spawn_command(cmd).unwrap();

        // Release any handles owned by the slave: we don't need it now
        // that we've spawned the child.
        drop(pair.slave);

        // Read the output in another thread.
        // This is important because it is easy to encounter a situation
        // where read/write buffers fill and block either your process
        // or the spawned process.
        let (tx_read, rx_read) = std::sync::mpsc::channel();
        let mut reader = pair.master.try_clone_reader().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0; 512];
            loop {
                let n = reader.read(&mut buf).unwrap();
                let _ = tx_read.send(String::from_utf8(buf[0..n].to_vec()).unwrap());
            }
        });

        let mut writer = pair.master.take_writer().unwrap();
        let (tx_write, rx_write): (Sender<String>, _) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            while let Ok(buf) = rx_write.recv() {
                writer.write(&buf.into_bytes()).unwrap();
            }
        });

        Ok(Self { rx_read, tx_write })
    }
}

#[no_mangle]
// can't use new since its a reserved keyword in javascript
pub unsafe extern "C" fn create(command: *mut i8) -> *const Mutex<Pty> {
    let command: Command = cstr_to_type(command).unwrap();
    let Ok(pty) = Pty::new(command) else {
        return std::ptr::null();
    };
    Arc::into_raw(Arc::new(Mutex::new(pty)))
}
#[no_mangle]
pub unsafe extern "C" fn read(this: *const Mutex<Pty>) -> *mut i8 {
    let this = ManuallyDrop::new(Arc::from_raw(this));
    let this = this.lock().expect("failed to aquire lock"); // is it safe ?
    if let Ok(r) = this.rx_read.recv() {
        return CString::new(r).unwrap().into_raw();
    }
    std::ptr::null_mut()
}

#[no_mangle]
pub unsafe extern "C" fn write(this: *const Mutex<Pty>, data: *mut i8) {
    let this = ManuallyDrop::new(Arc::from_raw(this));
    let this = this.lock().expect("failed to aquire lock"); // is it safe ?

    let data = CString::from_raw(data);
    let data_str = data.clone().into_string().unwrap();
    this.tx_write.send(data_str).unwrap();
    std::mem::forget(data);
}

#[no_mangle]
pub unsafe extern "C" fn tmp_dir() -> *mut i8 {
    CString::new(std::env::temp_dir().to_str().unwrap().to_owned())
        .unwrap()
        .into_raw()
}
