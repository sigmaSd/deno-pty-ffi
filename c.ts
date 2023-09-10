#!/usr/bin/env -S deno run --unstable --allow-all
import { Pty } from "https://deno.land/x/deno_pty_ffi@0.14.0/mod.ts";
// import { stripAnsiCode } from "https://deno.land/std@0.201.0/fmt/colors.ts";
import {
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.184.0/testing/asserts.ts";

const ANSI_PATTERN = new RegExp(
  [
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)",
    "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TXZcf-nq-uy=><~]))",
  ].join("|"),
  "g",
);

/**
 * @deprecated (will be removed in 1.0.0) Use `stripAnsiCode` instead.
 *
 * Remove ANSI escape codes from the string.
 * @param string to remove ANSI escape codes from
 */
export const stripColor = stripAnsiCode;

/**
 * Remove ANSI escape codes from the string.
 * @param string to remove ANSI escape codes from
 */
export function stripAnsiCode(string: string): string {
  return string.replace(ANSI_PATTERN, "");
}

if (import.meta.main) {
  await new Deno.Command("cargo", { args: ["b"], cwd: "./IRust" }).spawn()
    .status;
  // const targetDir = Deno.env.get("CARGO_TARGET_DIR") || "target";
  // const cmd = Deno.build.os !== "windows" ? "irust" : "irust.exe";
  const pty = await Pty.create({
    // cmd: "./irust-irust@1.71.2-x86_64-pc-windows-msvc/irust.exe",
    cmd: "./IRust/target/release/irust.exe",
    args: ["--default-config"],
    env: [["NO_COLOR", "1"]],
  });

  const read = async () => {
    let out = "";
    while (true) {
      let input = await pty.read();
      input = stripAnsiCode(input!).replaceAll("\b", "").trim();
      console.log("input:", JSON.stringify(input));
      out += input;
      if (input.endsWith("In:")) break;
    }
    return out;
  };

  const write = async (input: string) => await pty.write(input + "\n\r");

  const test2 = async (input: string, expected: string | RegExp) => {
    await write(input);
    const out = await read();
    const r = out.slice(out.indexOf(input)! + input.length).slice(0, -3).trim()
      .replaceAll("In:", "");
    if (typeof expected === "string") {
      assertEquals(r, expected);
    } else {
      assertMatch(r, expected);
    }
  };

  // await read();
  while (true) {
    let input = await pty.read();
    input = stripAnsiCode(input!).replaceAll("\b", "").trim();
    console.log("input:", JSON.stringify(input));
    // out += input;
    if (input.includes("In:")) break;
  }

  await write('let a = "hello";');
  await read();

  await test2(":type a", "`&str`");

  await write(`fn fact(n: usize) -> usize {
      match n {
        1 => 1,
        n => n * fact(n-1)
      }
  }`);
  await read();

  await test2("fact(4)", "Out: 24");

  await test2("z", /cannot find value `z`/);

  //  NOTE: this requires network, is it a good idea to enable it ?
  await write(":add regex");
  console.log("rrrr:", await read());
  await test2('regex::Regex::new("a.*a")', 'Out: Ok(Regex("a.*a"))');
}
