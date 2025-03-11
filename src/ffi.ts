import * as plug from "@denosaurs/plug";
import metadata from "../deno.json" with { type: "json" };
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
  /** The working directory for the command. defaults to the current working directory. */
  cwd?: string;
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
  },
  pty_write: {
    parameters: ["pointer", "buffer", "buffer"],
    result: "i8",
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
} satisfies Deno.ForeignLibraryInterface;

export async function instantiate(): Promise<
  Deno.DynamicLibrary<typeof SYMBOLS>
> {
  const name = "pty";
  const url =
    `https://github.com/sigmaSd/deno-pty-ffi/releases/download/${metadata.version}`;

  return await plug.dlopen(
    {
      name,
      url: Deno.env.get("RUST_LIB_PATH") || url,
      // reload cache if developping locally
      cache: Deno.env.get("RUST_LIB_PATH") ? "reloadAll" : "use",
      suffixes: {
        linux: {
          aarch64: "_aarch64",
          x86_64: "_x86_64",
        },
        darwin: {
          aarch64: "_arm64",
          x86_64: "_x86_64",
        },
      },
    },
    SYMBOLS,
  );
}
