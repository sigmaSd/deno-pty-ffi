import * as plug from "@denosaurs/plug";
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

export async function instantiate(): Promise<
  Deno.DynamicLibrary<typeof SYMBOLS>
> {
  const name = "pty";
  // Tag version with the prebuilt lib
  // It doesn't have to be the same as the library version
  // Only update it when the rust library gets updated
  const version = "0.21.0";
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
