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
  create: { parameters: ["buffer"]; result: "pointer" };
  read: {
    parameters: ["pointer"];
    result: "buffer";
    nonblocking: boolean;
  };
  write: {
    parameters: ["pointer", "buffer"];
    result: "i8";
    nonblocking: boolean;
  };
  tmp_dir: {
    parameters: [];
    result: "buffer";
  };
}

export class Pty {
  #lib;
  #this;

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
    const version = "0.1.0";
    // NOTE: replace this url with the correct repo url
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
            aarch64: "_aarch64.dylib",
            x86_64: "_x86_64.dylib",
          },
        },
      },
      {
        create: { parameters: ["buffer"], result: "pointer" },
        read: {
          parameters: ["pointer"],
          result: "buffer",
          nonblocking: true,
        },
        write: {
          parameters: ["pointer", "buffer"],
          result: "i8",
          nonblocking: true,
        },
        tmp_dir: {
          parameters: [],
          result: "buffer",
        },
      } satisfies PtyApi,
    );

    const pty = lib.symbols.create(encode_json_cstring(command));
    return new Pty({ lib, pty });
  }

  async read() {
    const data = await this.#lib.symbols.read(this.#this);
    if (data === null) throw "failed to read data";
    return decode_cstring(data);
  }

  async write(data: string) {
    const result = await this.#lib.symbols.write(
      this.#this,
      encode_cstring(data),
    ) as 0 | -1;
    if (result === -1) throw "failed to write data: " + data;
  }

  tmpDir() {
    const tempDir = this.#lib.symbols.tmp_dir();
    if (tempDir === null) throw "failed to get temp dir";
    return decode_cstring(tempDir);
  }
}
