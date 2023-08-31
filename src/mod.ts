import { plug } from "./deps.ts";
import {
  decode_cstring,
  encode_cstring,
  encode_json_cstring,
} from "./utils.ts";

export interface Command {
  cmd: string;
  args: string[];
  env: [string, string][];
}

interface PtyApi extends Deno.ForeignLibraryInterface {
  pty_create: { parameters: ["buffer", "buffer"]; result: "i8" };
  pty_read: {
    parameters: ["pointer", "buffer"];
    result: "i8";
    nonblocking: boolean;
  };
  pty_write: {
    parameters: ["pointer", "buffer", "buffer"];
    result: "i8";
    nonblocking: boolean;
  };
  tmp_dir: {
    parameters: ["buffer"];
    result: "i8";
  };
}

export class Pty {
  #lib;
  #this;
  #processExited = false;

  /** We want an async constructor so we can't use this default one*/
  constructor(
    { lib, pty }: {
      lib: Deno.DynamicLibrary<PtyApi>;
      pty: Deno.PointerValue;
    },
  ) {
    this.#lib = lib;
    this.#this = pty;
  }

  /** Async constructor
  Async needed because plug.dlopen is async
  */
  static async create(command: Command) {
    const name = "pty";
    // Tag version with the prebuilt lib
    // It doesn't have to be the same as the library version
    // Only update it when the rust library gets updated
    const version = "0.12.0";
    const url =
      `https://github.com/sigmaSd/deno-pty-ffi/releases/download/${version}`;

    const lib = await plug.dlopen(
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
      {
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
        tmp_dir: {
          parameters: ["buffer"],
          result: "i8",
        },
      } satisfies PtyApi,
    );

    const pty_buf = new Uint8Array(8);
    const result = lib.symbols.pty_create(
      encode_json_cstring(command),
      pty_buf,
    );
    const ptr = Deno.UnsafePointer.create(
      new BigUint64Array(pty_buf.buffer)[0],
    )!;
    if (result === -1) throw new Error(decode_cstring(ptr));
    return new Pty({ lib, pty: ptr });
  }

  async read() {
    if (this.#processExited) return;
    const dataBuf = new Uint8Array(8);
    const result = await this.#lib.symbols.pty_read(this.#this, dataBuf);
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

  async write(data: string) {
    // NOTE: maybe we should tell the user that the process exited
    if (this.#processExited) return;
    const errBuf = new Uint8Array(8);
    const result = await this.#lib.symbols.pty_write(
      this.#this,
      encode_cstring(data),
      errBuf,
    );
    const ptr = Deno.UnsafePointer.create(
      new BigUint64Array(errBuf.buffer)[0],
    )!;
    if (result === -1) throw new Error(decode_cstring(ptr));
  }

  tmpDir() {
    const tempDirBuf = new Uint8Array(8);
    const result = this.#lib.symbols.tmp_dir(tempDirBuf);
    const ptr = Deno.UnsafePointer.create(
      new BigUint64Array(tempDirBuf.buffer)[0],
    )!;
    if (result === -1) throw new Error(decode_cstring(ptr));
    return decode_cstring(ptr);
  }

  //NOTE: rewrite this with `using` when typescript 5.2 lands
  close() {
    this.#lib.close();
  }
}
