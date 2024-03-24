import { type Command, instantiate, type PtySize } from "./ffi.ts";
import {
  createPtrFromBuf,
  decode_cstring,
  decode_json_cstring,
  encode_cstring,
  encode_json_cstring,
} from "./utils.ts";

// NOTE: consier exporting this, so the user decides when to instantiate
// NOTE(2): The Libary should remain alive as long as the program is running
const LIBRARY = await instantiate();

/**
 * A class representing a Pty.
 */
export class Pty {
  #this;
  #processExited = false;

  /**
   * Creates a new Pty instance with the specified command.
   * @param command - The command to be executed in the pty.
   */
  constructor(command: Command) {
    const pty_buf = new Uint8Array(8);
    const result = LIBRARY.symbols.pty_create(
      encode_json_cstring(command),
      pty_buf,
    );
    const ptr = createPtrFromBuf(pty_buf);
    if (result === -1) throw new Error(decode_cstring(ptr));
    this.#this = ptr;
  }

  /**
   * Reads data from the pty.
   * @returns A Promise that resolves to the data read from the pty.
   */
  async read(): Promise<{ data: string; done: boolean }> {
    if (this.#processExited) return { data: "", done: true };
    const dataBuf = new Uint8Array(8);
    const result = await LIBRARY.symbols.pty_read(this.#this, dataBuf);
    const ptr = createPtrFromBuf(dataBuf);

    if (result === 99) {
      /* Process exited */
      this.#processExited = true;
      return { data: "", done: true };
    }
    if (result === -1) throw new Error(decode_cstring(ptr));
    return { data: decode_cstring(ptr), done: false };
  }

  /**
   * Writes data to the pty.
   * @param data - The data to write to the pty.
   */
  async write(data: string): Promise<void> {
    // NOTE: maybe we should tell the user that the process exited
    if (this.#processExited) return;
    const errBuf = new Uint8Array(8);
    const result = await LIBRARY.symbols.pty_write(
      this.#this,
      encode_cstring(data),
      errBuf,
    );
    if (result === -1) {
      throw new Error(decode_cstring(createPtrFromBuf(errBuf)));
    }
  }

  /**
   * Gets the size of the pty.
   * @returns The size of the pty.
   */
  getSize(): PtySize {
    const dataBuf = new Uint8Array(8);
    const result = LIBRARY.symbols.pty_get_size(this.#this, dataBuf);
    const ptr = createPtrFromBuf(dataBuf);
    if (result === -1) throw new Error(decode_cstring(ptr));
    return decode_json_cstring(ptr);
  }

  /**
   * Resizes the pty to the specified size.
   * @param size - The new size for the pty.
   */
  resize(size: PtySize): void {
    const errBuf = new Uint8Array(8);
    const result = LIBRARY.symbols.pty_resize(
      this.#this,
      encode_json_cstring(size),
      errBuf,
    );
    if (result === -1) {
      throw new Error(decode_cstring(createPtrFromBuf(errBuf)));
    }
  }

  /**
    Close the Pty, the pty won't be usable after this call
    NOTE: the process isn't killed in windows (https://github.com/sigmaSd/deno-pty-ffi/issues/4)
  */
  close(): void {
    this.#processExited = true;
    LIBRARY.symbols.pty_close(this.#this);
  }

  /**
   * Gets the temporary directory path.
   * @returns The path to the temporary directory.
   */
  tmpDir(): string {
    const tempDirBuf = new Uint8Array(8);
    const result = LIBRARY.symbols.tmp_dir(tempDirBuf);
    const ptr = createPtrFromBuf(tempDirBuf);
    if (result === -1) throw new Error(decode_cstring(ptr));
    return decode_cstring(ptr);
  }
}
