import { plug } from "./deps.ts";
import {
  decode_cstring,
  decode_json_cstring,
  encode_cstring,
  encode_json_cstring,
} from "./utils.ts";

/**
 * Represents a command to be executed in the pty.
 */
export interface Command {
  /** The command to be executed. */
  cmd: string;
  /** The arguments for the command. */
  args: string[];
  /** The environment variables for the command. */
  env: [string, string][];
}

/**
 * Represents the size of the visible display area in the pty.
 */
export interface PtySize {
  /** The number of lines of text. */
  rows: number;
  /** The number of columns of text. */
  cols: number;
  /** The width of a cell in pixels. Note that some systems may ignore this value. */
  pixel_width: number;
  /** The height of a cell in pixels. Note that some systems may ignore this value. */
  pixel_height: number;
}

const SYMBOLS = {
  pty_create: { parameters: ["buffer", "buffer"], result: "i8" },
  pty_read: {
    parameters: ["pointer", "buffer"],
    result: "i8",
    nonblocking: true,
  },
  pty_write: {
    parameters: ["pointer", "buffer", "buffer"],
    result: "i8",
    nonblocking: true,
  },
  pty_get_size: {
    parameters: ["pointer", "buffer"],
    result: "i8",
  },
  pty_resize: {
    parameters: ["pointer", "buffer", "buffer"],
    result: "i8",
  },
  pty_close: {
    parameters: ["pointer"],
    result: "void",
  },
  tmp_dir: {
    parameters: ["buffer"],
    result: "i8",
  },
} as const;
// NOTE: consier exporting this, so the user decides when to instantiate
// NOTE(2): The Libary should remain alive as long as the program is running
const LIBRARY = await instantiate();
async function instantiate(): Promise<Deno.DynamicLibrary<typeof SYMBOLS>> {
  const name = "pty";
  // Tag version with the prebuilt lib
  // It doesn't have to be the same as the library version
  // Only update it when the rust library gets updated
  const version = "0.19.0";
  const url =
    `https://github.com/sigmaSd/deno-pty-ffi/releases/download/${version}`;

  return await plug.dlopen(
    {
      name,
      url: Deno.env.get("RUST_LIB_PATH") || url,
      // reload cache if developping locally
      cache: Deno.env.get("RUST_LIB_PATH") ? "reloadAll" : "use",
      suffixes: {
        darwin: {
          aarch64: "_aarch64",
          x86_64: "_x86_64",
        },
      },
    },
    SYMBOLS,
  );
}

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
    const ptr = Deno.UnsafePointer.create(
      new BigUint64Array(pty_buf.buffer)[0],
    )!;
    if (result === -1) throw new Error(decode_cstring(ptr));
    this.#this = ptr;
  }

  /**
   * Reads data from the pty.
   * @returns A Promise that resolves to the data read from the pty.
   */
  async read(): Promise<string | undefined> {
    if (this.#processExited) return;
    const dataBuf = new Uint8Array(8);
    const result = await LIBRARY.symbols.pty_read(this.#this, dataBuf);
    const ptr = Deno.UnsafePointer.create(
      new BigUint64Array(dataBuf.buffer)[0],
    )!;
    if (result === 99) {
      /* Process exited */
      this.#processExited = true;
      return;
    }
    if (result === -1) throw new Error(decode_cstring(ptr));
    return decode_cstring(ptr);
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
    const ptr = Deno.UnsafePointer.create(
      new BigUint64Array(errBuf.buffer)[0],
    )!;
    if (result === -1) throw new Error(decode_cstring(ptr));
  }

  /**
   * Gets the size of the pty.
   * @returns The size of the pty.
   */
  getSize(): PtySize {
    const dataBuf = new Uint8Array(8);
    const result = LIBRARY.symbols.pty_get_size(this.#this, dataBuf);
    const ptr = Deno.UnsafePointer.create(
      new BigUint64Array(dataBuf.buffer)[0],
    )!;
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
    const ptr = Deno.UnsafePointer.create(
      new BigUint64Array(errBuf.buffer)[0],
    )!;
    if (result === -1) throw new Error(decode_cstring(ptr));
  }

  /**
    Close the Pty, the pty won't be usable after this call
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
    const ptr = Deno.UnsafePointer.create(
      new BigUint64Array(tempDirBuf.buffer)[0],
    )!;
    if (result === -1) throw new Error(decode_cstring(ptr));
    return decode_cstring(ptr);
  }
}
