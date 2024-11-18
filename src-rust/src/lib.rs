use crossbeam::channel::{unbounded, Receiver, Sender};
use portable_pty::{
    native_pty_system, ChildKiller as Ck, CommandBuilder, MasterPty, PtySize, SlavePty,
};
use serde::{Deserialize, Serialize};
use std::{cell::Cell, ffi::CString, io::Read, mem::ManuallyDrop, time::Duration};
mod utils;
use std::os::raw::c_char;
use utils::{boxed_error_to_cstring, cstr_to_type, type_to_cstr};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub struct Pty {
    reader: PtyReader,
    tx_write: Sender<String>,
    // keep the slave alive
    // so windows works
    // https://github.com/wez/wezterm/issues/4206
    _slave: Box<dyn SlavePty + Send>,
    master: Box<dyn MasterPty + Send>,
    // use to end the spawned process
    ck: Box<dyn Ck>,
}

#[derive(Clone)]
struct PtyReader {
    rx_read: Receiver<Message>,
    done: Cell<bool>,
}
impl PtyReader {
    fn new(rx_read: Receiver<Message>) -> PtyReader {
        Self {
            rx_read,
            done: Cell::new(false),
        }
    }
    //NOTE: this function should not block
    fn read(&self) -> Result<Message> {
        if self.done.get() {
            return Ok(Message::End);
        }

        let mut msgs: Vec<_> = self.rx_read.try_iter().collect();

        if msgs.contains(&Message::End) {
            self.done.set(true);

            // NOTE: We received the END message, this means that the process has exited
            // But there could be some pending messages in the read channel, this is especisally true in windows
            // So sleep a bit and check the channel again
            std::thread::sleep(Duration::from_millis(100));
            msgs.extend(self.rx_read.try_iter());

            if msgs.len() == 1 {
                return Ok(Message::End);
            }

            // we might have some msgs here
            // we should send them to the user
            msgs.retain(|msg| !matches!(msg, Message::End));
        }

        let msg = msgs
            .iter()
            .map(|msg| {
                if let Message::Data(data) = msg {
                    data.as_str()
                } else {
                    unreachable!()
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

#[derive(PartialEq, Eq, Debug)]
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
        let ck = child.clone_killer();

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
                if n == 0 {
                    // the pty has already exited
                    // so no need to send the end message?
                    break;
                };
                tx_read
                    .send(Message::Data(
                        String::from_utf8(buf[0..n].to_vec()).expect("data is not valid utf8"),
                    ))
                    .ok(); // the sender closed (the program finished ?);
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
            master: pair.master,
            ck,
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

    fn resize(&self, size: PtySize) -> Result<()> {
        self.master.resize(size).map_err(Into::into)
    }

    fn get_size(&self) -> Result<PtySize> {
        self.master.get_size().map_err(Into::into)
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
pub unsafe extern "C" fn pty_create(command: *mut c_char, result: *mut usize) -> i8 {
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
            *result = boxed_error_to_cstring(err).into_raw() as _;
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
        let this = unsafe { &*this };
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
            *result = boxed_error_to_cstring(err).into_raw() as _;
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
pub unsafe extern "C" fn pty_write(this: *mut Pty, data: *mut c_char, result: *mut usize) -> i8 {
    let this = unsafe { &*this };
    let data = ManuallyDrop::new(CString::from_raw(data));
    match (|| {
        let data_str = data.to_str()?.to_owned(); // NOTE: can we send str in the channels ?
        this.write(data_str)
    })() {
        Ok(()) => 0,
        Err(err) => {
            *result = boxed_error_to_cstring(err).into_raw() as _;
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
#[no_mangle]
pub unsafe extern "C" fn pty_get_size(this: *mut Pty, result: *mut usize) -> i8 {
    let this = unsafe { &*this };
    match (|| -> Result<CString> {
        let size = this.get_size()?;
        type_to_cstr(&size)
    })() {
        Ok(size) => {
            *result = size.into_raw() as _;
            0
        }
        Err(err) => {
            *result = boxed_error_to_cstring(err).into_raw() as _;
            -1
        }
    }
}

/// # Safety
/// - Requires a valid pointer to a Pty
/// - Requires a valid pointer to a PtySize encoded as CString
/// - Requires a valid pointer to a buffer of size 8
/// to write the error to
///
/// Returns -1 on error
#[no_mangle]
pub unsafe extern "C" fn pty_resize(this: *mut Pty, size: *mut c_char, result: *mut usize) -> i8 {
    let this = unsafe { &*this };
    match (|| -> Result<()> {
        let size = cstr_to_type::<PtySize>(size)?;
        this.resize(size)?;
        Ok(())
    })() {
        Ok(()) => 0,
        Err(err) => {
            *result = boxed_error_to_cstring(err).into_raw() as _;
            -1
        }
    }
}

/// # Safety
/// - Requires a valid pointer to a Pty
#[no_mangle]
pub unsafe extern "C" fn pty_close(this: *mut Pty) {
    // NOTE: Dropping the pty doensn't work on windows and trigger random bugs https://github.com/sigmaSd/deno-pty-ffi/issues/3
    if cfg!(windows) {
        let _this = ManuallyDrop::new(Box::from_raw(this));
        // killing doesn't work https://github.com/wez/wezterm/issues/5107
        // let _ = this.ck.kill();
    } else {
        let mut this = Box::from_raw(this);
        // NOTE: maybe propage the possible error
        let _ = this.ck.kill();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;
    #[test]
    fn it_works() {
        let mut threads = vec![];
        for _ in 0..10 {
            threads.push(std::thread::spawn(|| {
                let pty = Pty::create(Command {
                    cmd: "deno".into(),
                    args: vec!["repl".into()],
                    env: vec![("NO_COLOR".into(), "1".into())],
                })
                .unwrap();

                // read header
                pty.read().unwrap();

                let write_and_expect = |to_write: &'static str, expect: &'static str| {
                    pty.write(to_write.into()).unwrap();

                    let (tx, rx) = mpsc::channel();
                    let reader = pty.clone_reader();
                    std::thread::spawn(move || loop {
                        let r = reader.read().unwrap();
                        match r {
                            Message::Data(data) => {
                                if data.contains(expect) {
                                    tx.send(()).unwrap();
                                    break;
                                }
                            }
                            Message::End => break,
                        }
                    });
                    rx.recv().unwrap();
                };

                write_and_expect("5+4\n\r", "9");
                write_and_expect("let a = 4; a + a\n\r", "8");

                // test size, resize
                assert!(matches!(
                    pty.get_size(),
                    Ok(PtySize {
                        rows: 24,
                        cols: 80,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                ));

                pty.resize(PtySize {
                    rows: 50,
                    cols: 120,
                    pixel_width: 1,
                    pixel_height: 1,
                })
                .unwrap();
                assert!(matches!(
                    pty.get_size(),
                    Ok(PtySize {
                        rows: 50,
                        cols: 120,
                        pixel_width: 1,
                        pixel_height: 1,
                    })
                ));
            }));
        }
        threads.into_iter().for_each(|t| t.join().unwrap());
    }
}
