import { type Command, instantiate, type PtySize } from "./ffi.ts";
import {
  decodeCString,
  decodePointerLenData,
  encodeCString,
  encodePointerLenData,
  freeRustData,
  freeRustString,
  readErrorAndFree, // Use the combined read+free for errors
  readPointerFromResultBuffer,
} from "./utils.ts";

// NOTE: consier exporting this, so the user decides when to instantiate
// NOTE(2): The Libary should remain alive as long as the program is running
const LIBRARY = await instantiate();

// --- Result type for read operations ---
export type PtyReadResult = {
  data: string;
  done: false;
} | {
  done: true;
  data: undefined; // Or null, for consistency
};

export class Pty {
  #ptr: Deno.PointerValue; // The opaque pointer to the Rust Pty struct

  constructor(command: Command) {
    // 1. Encode command using pointer + length
    const cmdData = encodePointerLenData(command);
    const cmdDataPtr = Deno.UnsafePointer.of(cmdData); // Get pointer TO the TS buffer

    // 2. Prepare result buffer (for the Pty pointer or error CString pointer)
    const resultPtrBuf = new BigUint64Array(1);

    // 3. Call FFI function
    const status = LIBRARY.symbols.pty_create(
      cmdDataPtr,
      BigInt(cmdData.length),
      resultPtrBuf, // Pass buffer for Rust to write result pointer into
    );

    // 4. Handle result
    if (status === -1) {
      // Error occurred, resultPtrBuf contains error CString pointer
      const errorMsg = readErrorAndFree(LIBRARY, resultPtrBuf);
      throw new Error(`Pty creation failed: ${errorMsg}`);
    }

    // Success, resultPtrBuf contains the Pty pointer
    const ptyPtr = readPointerFromResultBuffer(resultPtrBuf);
    if (!ptyPtr) {
      // Should not happen if status is 0, but check defensively
      throw new Error("Pty creation succeeded but returned a null pointer.");
    }
    this.#ptr = ptyPtr;
  }

  /**
   * Reads pending output from the PTY (non-blocking).
   * Returns an empty string if no new data is available.
   * Returns { done: true } if the process has exited.
   */
  read(): PtyReadResult {
    if (!this.#ptr) throw new Error("Pty is closed.");

    const resultPtrBuf = new BigUint64Array(1);
    const status = LIBRARY.symbols.pty_read(this.#ptr, resultPtrBuf);

    switch (status) {
      case 0: { // Success, data available
        const dataPtr = readPointerFromResultBuffer(resultPtrBuf);
        if (!dataPtr) {
          // This might mean an empty string was read "" which CString::new("") handles.
          // If Rust guarantees non-null ptr for status 0, this is an internal error.
          console.warn("pty_read returned status 0 but a null data pointer.");
          return { data: "", done: false };
        }
        try {
          const data = decodeCString(dataPtr);
          return { data, done: false };
        } finally {
          freeRustString(LIBRARY, dataPtr); // Free the CString memory
        }
      }
      case 99: // Process finished
        return { done: true, data: undefined };
      case -1: { // Error
        const errorMsg = readErrorAndFree(LIBRARY, resultPtrBuf);
        throw new Error(`Pty read failed: ${errorMsg}`);
      }
      default:
        throw new Error(`Pty read returned unexpected status: ${status}`);
    }
  }

  /**
   * Reads output from the PTY, blocking until data is available or the process exits.
   * Returns { done: true } if the process has exited.
   */
  readSync(): PtyReadResult {
    if (!this.#ptr) throw new Error("Pty is closed.");

    const resultPtrBuf = new BigUint64Array(1);
    const status = LIBRARY.symbols.pty_read_sync(this.#ptr, resultPtrBuf);

    switch (status) {
      case 0: { // Success, data available
        const dataPtr = readPointerFromResultBuffer(resultPtrBuf);
        if (!dataPtr) {
          console.warn(
            "pty_read_sync returned status 0 but a null data pointer.",
          );
          return { data: "", done: false };
        }
        try {
          const data = decodeCString(dataPtr);
          return { data, done: false };
        } finally {
          freeRustString(LIBRARY, dataPtr); // Free the CString memory
        }
      }
      case 99: // Process finished
        return { done: true, data: undefined };
      case -1: { // Error
        const errorMsg = readErrorAndFree(LIBRARY, resultPtrBuf);
        throw new Error(`Pty readSync failed: ${errorMsg}`);
      }
      default:
        throw new Error(`Pty readSync returned unexpected status: ${status}`);
    }
  }

  /** Writes data to the PTY's input. */
  write(data: string): void {
    if (!this.#ptr) throw new Error("Pty is closed.");

    // Encode data as CString (null-terminated) for pty_write
    const dataCStr = encodeCString(data);

    const errorPtrBuf = new BigUint64Array(1);

    const status = LIBRARY.symbols.pty_write(
      this.#ptr,
      dataCStr,
      errorPtrBuf,
    );

    if (status === -1) {
      const errorMsg = readErrorAndFree(LIBRARY, errorPtrBuf);
      throw new Error(`Pty write failed: ${errorMsg}`);
    }
    // Success, nothing to return
  }

  /** Gets the current PTY terminal size. */
  getSize(): PtySize {
    if (!this.#ptr) throw new Error("Pty is closed.");

    const resultDataPtrBuf = new BigUint64Array(1); // For *mut u8
    const resultLenBuf = new BigUint64Array(1); // For usize
    const errorPtrBuf = new BigUint64Array(1); // For error CString *

    const status = LIBRARY.symbols.pty_get_size(
      this.#ptr,
      resultDataPtrBuf,
      resultLenBuf,
      errorPtrBuf,
    );

    if (status === -1) {
      const errorMsg = readErrorAndFree(LIBRARY, errorPtrBuf);
      throw new Error(`Pty getSize failed: ${errorMsg}`);
    }

    // Success, read pointer and length
    const dataPtr = readPointerFromResultBuffer(resultDataPtrBuf);
    const len = Number(resultLenBuf[0]); // usize fits in JS number

    if (!dataPtr) {
      // Should not happen on success, maybe means empty size data?
      throw new Error("Pty getSize succeeded but returned null data pointer.");
    }

    try {
      const size = decodePointerLenData<PtySize>(dataPtr, len);
      return size;
    } finally {
      // Free the raw data buffer allocated by Rust
      freeRustData(LIBRARY, dataPtr, len);
    }
  }

  /** Resizes the PTY terminal. */
  resize(size: PtySize): void {
    if (!this.#ptr) throw new Error("Pty is closed.");

    // Encode size using pointer + length
    const sizeData = encodePointerLenData(size);
    const sizeDataPtr = Deno.UnsafePointer.of(sizeData);

    const errorPtrBuf = new BigUint64Array(1);

    const status = LIBRARY.symbols.pty_resize(
      this.#ptr,
      sizeDataPtr,
      BigInt(sizeData.length),
      errorPtrBuf,
    );

    if (status === -1) {
      const errorMsg = readErrorAndFree(LIBRARY, errorPtrBuf);
      throw new Error(`Pty resize failed: ${errorMsg}`);
    }
    // Success
  }

  /**
   * Closes the PTY, drops the Rust object, and attempts to kill the child process.
   * The Pty object should not be used after calling this.
   */
  close(): void {
    if (this.#ptr) {
      try {
        LIBRARY.symbols.pty_close(this.#ptr);
      } catch (e) {
        // Log error during close but don't prevent library closing
        console.error("Error during pty_close FFI call:", e);
      }
      this.#ptr = null; // Mark as unusable
      // LIBRARY.close(); // The library will be cleaned at exit, don't call this when the program is still running
    }
  }
}
