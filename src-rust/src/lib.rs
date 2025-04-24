use crossbeam::channel::{Receiver, Sender, unbounded};
use portable_pty::{
    ChildKiller as Ck, CommandBuilder, MasterPty, PtySize, SlavePty, native_pty_system,
};
use serde::{Deserialize, Serialize};
use std::{
    cell::Cell,
    ffi::{CString, c_char},
    io::Read,
    mem::forget,
    slice,
    time::Duration,
};
mod utils;
use utils::boxed_error_to_cstring;

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

            // Filter out the End message itself after collecting potentially pending data
            msgs.retain(|msg| !matches!(msg, Message::End));

            if msgs.is_empty() {
                return Ok(Message::End); // Truly the end if no data remains
            }
            // If only End was received initially but more data came in the retry,
            // we proceed to bundle the data below.
        }

        // msgs is empty but we didn't receive End Message
        if msgs.is_empty() {
            // No data, no end signal yet
            return Ok(Message::Data("".to_string()));
        }

        let combined_data = msgs
            .iter()
            .map(|msg| {
                // Use filter_map to handle potential non-Data variants safely
                if let Message::Data(data) = msg {
                    data.as_str()
                } else {
                    unreachable!("we already filtered End messages")
                }
            })
            .collect::<Vec<_>>()
            .join("");

        Ok(Message::Data(combined_data))
    }
}

#[derive(Serialize, Deserialize, Debug)]
struct Command {
    cmd: String,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
    cwd: Option<String>,
}

#[derive(PartialEq, Eq, Debug)]
enum Message {
    Data(String),
    End,
}

impl Pty {
    fn create(command: Command) -> Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd_builder = CommandBuilder::new(command.cmd);
        // https://github.com/wez/wezterm/issues/4205
        cmd_builder.env("PATH", std::env::var("PATH")?);
        if let Some(args) = command.args {
            cmd_builder.args(&args);
        }
        match command.cwd {
            Some(cwd) => cmd_builder.cwd(cwd),
            None => cmd_builder.cwd(std::env::current_dir()?),
        }
        if let Some(map) = command.env {
            for (key, val) in map {
                cmd_builder.env(key, val);
            }
        }

        let (tx_read, rx_read) = unbounded();
        let slave = pair.slave; // Keep slave handle

        // Spawn the command
        let mut child = slave.spawn_command(cmd_builder)?;
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
        let tx_read_reader_thread = tx_read.clone();
        std::thread::spawn(move || {
            // Reasonably sized buffer
            let mut buf = vec![0u8; 8 * 1024]; // 8KB buffer
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        match String::from_utf8(buf[..n].to_vec()) {
                            Ok(data) => {
                                if tx_read_reader_thread.send(Message::Data(data)).is_err() {
                                    break; // Receiver disconnected
                                }
                            }
                            Err(e) => {
                                // Handle non-UTF8 data? Log or send specific error?
                                // For now, let's log it and stop reading.
                                eprintln!("PTY read non-UTF8 data: {}", e);
                                // Maybe send an error message? For now, just break.
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        // Differentiate between temporary errors and fatal ones if possible
                        eprintln!("Error reading from PTY: {}", e);
                        break; // Stop reading on error
                    }
                }
            }
            // Ensure End is sent if reading stops for any reason other than receiver disconnect
            let _ = tx_read_reader_thread.send(Message::End);
        });

        // Thread for writing to PTY input
        let mut writer = pair.master.take_writer()?;
        let (tx_write, rx_write): (Sender<String>, _) = unbounded();
        std::thread::spawn(move || {
            while let Ok(data_to_write) = rx_write.recv() {
                if writer.write_all(data_to_write.as_bytes()).is_err() {
                    // Log error, maybe signal failure?
                    eprintln!("Error writing to PTY");
                    break; // Stop trying to write
                }
            }
        });

        Ok(Self {
            reader: PtyReader::new(rx_read),
            tx_write,
            _slave: slave, // Keep slave alive
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
        // Sending might fail if the writing thread panicked/exited
        self.tx_write.send(data).map_err(|e| e.into())
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
// == FFI Layer ==

/// Creates a new Pty instance.
///
/// # Safety
/// - `command_ptr` must point to a valid UTF-8 encoded JSON string representing the `Command` struct.
/// - `command_len` must be the correct byte length of the JSON string pointed to by `command_ptr`.
/// - `result_ptr` must point to a valid buffer where the pointer to the created Pty object will be written on success,
///   or where the pointer to a C-string error message will be written on failure.
///
/// # Returns
/// - `0` on success. The `usize` at `result_ptr` holds the opaque pointer to the `Pty`.
/// - `-1` on error. The `usize` at `result_ptr` holds a pointer to a null-terminated C string
///   containing the error message. This string must be freed by the caller using `free_string`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pty_create(
    command_ptr: *const u8,
    command_len: usize,
    result_ptr: *mut usize,
) -> i8 {
    let pty_result = (|| -> Result<Box<Pty>> {
        // Create a slice from the pointer and length
        let command_slice = unsafe { slice::from_raw_parts(command_ptr, command_len) };
        // Deserialize from the slice
        let command: Command = serde_json::from_slice(command_slice)?;
        // dbg!("Creating PTY with command: {:?}", &command);
        let pty = Pty::create(command)?;
        Ok(Box::new(pty))
    })();

    match pty_result {
        Ok(pty) => {
            unsafe { *result_ptr = Box::into_raw(pty) as usize };
            0 // Success
        }
        Err(err) => {
            unsafe { *result_ptr = boxed_error_to_cstring(err).into_raw() as _ };
            -1 // Error
        }
    }
}

/// Reads pending output from the Pty. This is non-blocking.
///
/// # Safety
/// - `pty_ptr` must be a valid pointer obtained from `pty_create`.
/// - `result_ptr` must point to a valid buffer where the result pointer will be written.
///
/// # Returns
/// - `0`: Success, data read. `result_ptr` holds a pointer to a null-terminated C string (UTF-8)
///   containing the data. This string must be freed by the caller using `free_string`. Empty string means no new data available currently.
// - `99`: Process exited normally, no more data will ever be available. `result_ptr` is not modified or set to null.
/// - `-1`: Error occurred. `result_ptr` holds a pointer to a null-terminated C string
///   containing the error message. This string must be freed by the caller using `free_string`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pty_read(pty_ptr: *mut Pty, result_ptr: *mut usize) -> i8 {
    let pty = unsafe { &*pty_ptr };
    match pty.read() {
        Ok(Message::Data(data)) => {
            match CString::new(data) {
                // Handles potential null bytes in data
                Ok(c_string) => {
                    unsafe { *result_ptr = c_string.into_raw() as _ };
                    0 // Success with data
                }
                Err(e) => {
                    // Data contained null bytes, shouldn't happen with valid UTF-8 read often, but handle it.
                    let err_str = format!("Failed to create CString from read data: {}", e);
                    unsafe { *result_ptr = boxed_error_to_cstring(err_str.into()).into_raw() as _ };
                    -1 // Error
                }
            }
        }
        Ok(Message::End) => {
            // *result_ptr = std::ptr::null_mut::<c_char>() as _; // Or don't touch it
            99 // Process exited
        }
        Err(err) => {
            unsafe { *result_ptr = boxed_error_to_cstring(err).into_raw() as _ };
            -1 // Error
        }
    }
}

/// Writes data to the Pty's input.
///
/// # Safety
/// - `pty_ptr` must be a valid pointer obtained from `pty_create`.
/// - `data_ptr` must point to a valid null-terminated C string (UTF-8) managed by the caller (e.g., JavaScript/TypeScript).
///   Rust will borrow this data but not take ownership or free it.
/// - `error_ptr` must point to a valid buffer where a C-string error message pointer
///   will be written on failure.
///
/// # Returns
/// - `0` on success.
/// - `-1` on error. `error_ptr` holds a pointer to a null-terminated C string (allocated by Rust)
///   containing the error message. This string must be freed by the caller using `free_string`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pty_write(
    pty_ptr: *mut Pty,
    data_ptr: *const c_char,
    error_ptr: *mut usize,
) -> i8 {
    // Ensure the pointer isn't null before creating CStr
    if data_ptr.is_null() {
        let err = Box::<dyn std::error::Error>::from("pty_write received null data pointer");
        unsafe { *error_ptr = boxed_error_to_cstring(err).into_raw() as _ };
        return -1;
    }

    let pty = unsafe { &*pty_ptr };
    // Borrow the C string data without taking ownership.
    // This is safe assuming data_ptr points to a valid, null-terminated C string.
    let data_cstr = unsafe { std::ffi::CStr::from_ptr(data_ptr) };

    match (|| -> Result<()> {
        // Convert borrowed CStr to borrowed Rust &str
        let data_str_borrowed = data_cstr.to_str()?;
        // Convert to owned String because the channel sender likely requires 'static data
        let data_str_owned = data_str_borrowed.to_owned();
        // Send the owned String through the channel
        pty.write(data_str_owned)?;
        Ok(())
    })() {
        Ok(()) => 0, // Success
        Err(err) => {
            unsafe { *error_ptr = boxed_error_to_cstring(err).into_raw() as _ };
            -1 // Error
        }
    }
}

/// Gets the current terminal size of the Pty.
///
/// # Safety
/// - `pty_ptr` must be a valid pointer obtained from `pty_create`.
/// - `result_data_ptr` must point to a valid buffer where the pointer to the
///   serialized `PtySize` data (JSON bytes) will be written on success.
/// - `result_len_ptr` must point to a valid buffer where the length of the
///   serialized data will be written on success.
/// - `error_ptr` must point to a valid buffer where a C-string error message pointer
///   will be written on failure.
///
/// # Returns
/// - `0` on success. `result_data_ptr` and `result_len_ptr` are populated. The data
///   pointed to by `result_data_ptr` must be freed by the caller using `free_data`.
/// - `-1` on error. `error_ptr` holds a pointer to a null-terminated C string
///   containing the error message. This string must be freed by the caller using `free_string`.
///   `result_data_ptr` and `result_len_ptr` are not guaranteed to be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pty_get_size(
    pty_ptr: *mut Pty,
    result_data_ptr: *mut *mut u8,
    result_len_ptr: *mut usize,
    error_ptr: *mut usize,
) -> i8 {
    let pty = unsafe { &*pty_ptr };
    match (|| -> Result<Vec<u8>> {
        let size = pty.get_size()?;
        // Serialize directly to Vec<u8> (JSON bytes)
        Ok(serde_json::to_vec(&size)?)
    })() {
        Ok(mut data_vec) => {
            // Ensure the vector has capacity == length for from_raw_parts later
            data_vec.shrink_to_fit();
            let ptr = data_vec.as_mut_ptr();
            let len = data_vec.len();

            // Prevent Rust from dropping the Vec's memory
            forget(data_vec);

            // Write the pointer and length back to the caller
            unsafe { *result_data_ptr = ptr };
            unsafe { *result_len_ptr = len };
            0 // Success
        }
        Err(err) => {
            unsafe { *error_ptr = boxed_error_to_cstring(err).into_raw() as _ };
            // Set output pointers to null/zero on error for clarity
            unsafe { *result_data_ptr = std::ptr::null_mut() };
            unsafe { *result_len_ptr = 0 };
            -1 // Error
        }
    }
}

/// Resizes the terminal dimensions of the Pty.
///
/// # Safety
/// - `pty_ptr` must be a valid pointer obtained from `pty_create`.
/// - `size_ptr` must point to a valid UTF-8 encoded JSON string representing the `PtySize` struct.
/// - `size_len` must be the correct byte length of the JSON string pointed to by `size_ptr`.
/// - `error_ptr` must point to a valid buffer where a C-string error message pointer
///   will be written on failure.
///
/// # Returns
/// - `0` on success.
/// - `-1` on error. `error_ptr` holds a pointer to a null-terminated C string
///   containing the error message. This string must be freed by the caller using `free_string`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pty_resize(
    pty_ptr: *mut Pty,
    size_ptr: *const u8,
    size_len: usize,
    error_ptr: *mut usize,
) -> i8 {
    let pty = unsafe { &*pty_ptr };
    match (|| -> Result<()> {
        let size_slice = unsafe { slice::from_raw_parts(size_ptr, size_len) };
        let size: PtySize = serde_json::from_slice(size_slice)?;
        pty.resize(size)?;
        Ok(())
    })() {
        Ok(()) => 0, // Success
        Err(err) => {
            unsafe { *error_ptr = boxed_error_to_cstring(err).into_raw() as _ };
            -1 // Error
        }
    }
}

/// Closes the Pty and attempts to kill the associated child process.
///
/// # Safety
/// - `pty_ptr` must be a valid pointer obtained from `pty_create`. It will be consumed (dropped) by this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pty_close(pty_ptr: *mut Pty) {
    if pty_ptr.is_null() {
        return;
    }
    // Take ownership of the Box<Pty> to drop it
    let mut pty = unsafe { Box::from_raw(pty_ptr) };

    // Attempt to kill the child process. Ignore errors (best effort).
    // On Windows, killing might be less reliable or have side effects.
    let _ = pty.ck.kill();

    // pty is dropped automatically here, closing handles and potentially
    // signaling threads to exit if they check channel status.
}

/// Frees a null-terminated C string previously allocated by Rust and passed to the caller.
///
/// # Safety
/// - `ptr` must be a pointer previously returned by a `pty_*` function that allocated
///   an error message or data string (e.g., from `pty_read`, `pty_create` on error).
/// - `ptr` must not have been already freed.
/// - `ptr` must point to a valid C string allocated via `CString::into_raw`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        // Reconstruct the CString from the raw pointer, taking ownership back.
        // Dropping the CString deallocates the memory.
        let _ = unsafe { CString::from_raw(ptr) };
    }
}

/// Frees raw byte data previously allocated by Rust and passed to the caller.
///
/// # Safety
/// - `ptr` must be a pointer previously returned by a `pty_*` function that allocated
///   raw data (e.g., the data pointer from `pty_get_size`).
/// - `len` must be the corresponding length returned alongside the pointer.
/// - The memory region (`ptr`, `len`) must not have been already freed.
/// - The memory must have been allocated originally via `Vec<u8>` and leaked using `forget`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn free_data(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        // Reconstruct the Vec<u8> from the raw parts, taking ownership back.
        // Using 'len' for capacity is correct here because we assume it came from
        // a Vec where len == capacity after shrink_to_fit().
        let _ = unsafe { Vec::from_raw_parts(ptr, len, len) };
        // Dropping the Vec deallocates the memory.
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
                    args: Some(vec!["repl".into()]),
                    env: Some([("NO_COLOR".into(), "1".into())].into()),
                    cwd: None,
                })
                .unwrap();

                // read header
                pty.read().unwrap();

                let write_and_expect = |to_write: &'static str, expect: &'static str| {
                    pty.write(to_write.into()).unwrap();

                    let (tx, rx) = mpsc::channel();
                    let reader = pty.clone_reader();
                    std::thread::spawn(move || {
                        loop {
                            let r = reader.read().unwrap();
                            match r {
                                Message::Data(data) => {
                                    if data.contains(expect) {
                                        tx.send(Ok(())).unwrap();
                                        break;
                                    }
                                }
                                Message::End => {
                                    tx.send(Err(())).unwrap();
                                    break;
                                }
                            }
                            std::thread::sleep(std::time::Duration::from_millis(100));
                        }
                    });
                    rx.recv().unwrap().unwrap();
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
