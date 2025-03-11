import { type Command, instantiate, type PtySize } from "./ffi.ts";
import {
  createPtrFromBuffer,
  decodeCstring,
  decodeJsonCstring,
  encodeCstring,
  encodeJsonCstring,
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
      encodeJsonCstring(command),
      pty_buf,
    );
    const ptr = createPtrFromBuffer(pty_buf);
    if (result === -1) throw new Error(decodeCstring(ptr));
    this.#this = ptr;
  }

  /**
   * Reads data from the pty.
   * @returns The data read from the pty.
   */
  read(): { data: string; done: boolean } {
    if (this.#processExited) return { data: "", done: true };
    const dataBuf = new Uint8Array(8);
    const result = LIBRARY.symbols.pty_read(this.#this, dataBuf);

    if (result === 99) {
      /* Process exited */
      this.#processExited = true;
      return { data: "", done: true };
    }
    const ptr = createPtrFromBuffer(dataBuf);

    if (result === -1) throw new Error(decodeCstring(ptr));
    return { data: decodeCstring(ptr), done: false };
  }

  /**
   * Writes data to the pty.
   * @param data - The data to write to the pty.
   */
  write(data: string): void {
    // NOTE: maybe we should tell the user that the process exited
    if (this.#processExited) return;
    const errBuf = new Uint8Array(8);
    const result = LIBRARY.symbols.pty_write(
      this.#this,
      encodeCstring(data),
      errBuf,
    );
    if (result === -1) {
      throw new Error(decodeCstring(createPtrFromBuffer(errBuf)));
    }
  }

  /**
   * Gets the size of the pty.
   * @returns The size of the pty.
   */
  getSize(): PtySize {
    const dataBuf = new Uint8Array(8);
    const result = LIBRARY.symbols.pty_get_size(this.#this, dataBuf);
    const ptr = createPtrFromBuffer(dataBuf);
    if (result === -1) throw new Error(decodeCstring(ptr));
    return decodeJsonCstring(ptr);
  }

  /**
   * Resizes the pty to the specified size.
   * @param size - The new size for the pty.
   */
  resize(size: PtySize): void {
    const errBuf = new Uint8Array(8);
    const result = LIBRARY.symbols.pty_resize(
      this.#this,
      encodeJsonCstring(size),
      errBuf,
    );
    if (result === -1) {
      throw new Error(decodeCstring(createPtrFromBuffer(errBuf)));
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
}
