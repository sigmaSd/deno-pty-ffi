import { assert, assertEquals } from "jsr:@std/assert@0.220.1";
import { Pty } from "../mod.ts";

async function write_and_expect(pty: Pty, toWrite: string, expect: string) {
  pty.write(toWrite);

  let success = false;
  while (true) {
    const { data, done } = pty.read();
    if (done) break;
    if (data?.includes(expect)) {
      success = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  assert(success);
}

Deno.test("smoke", async () => {
  const pty = new Pty({
    cmd: "deno",
    args: ["repl"],
    env: [["NO_COLOR", "1"]],
  });

  // read header
  pty.read();

  await write_and_expect(pty, "5+4\n\r", "9");
  await write_and_expect(pty, "let a = 4; a + a\n\r", "8");

  // test size, resize
  assertEquals(pty.getSize(), {
    rows: 24,
    cols: 80,
    pixel_height: 0,
    pixel_width: 0,
  });

  // close the first pty
  // we should still create other ptys
  pty.close();
});

Deno.test("getSize/resize", () => {
  const pty = new Pty({
    cmd: "deno",
    args: ["repl"],
    env: [["NO_COLOR", "1"]],
  });

  pty.resize({
    rows: 50,
    cols: 120,
    pixel_height: 1,
    pixel_width: 1,
  });
  assertEquals(pty.getSize(), {
    rows: 50,
    cols: 120,
    pixel_height: 1,
    pixel_width: 1,
  });

  pty.close();
});

Deno.test("with cwd set", async () => {
  const tmpDir = await Deno.makeTempDir();
  const pty = new Pty({
    cmd: "deno",
    args: ["repl"],
    env: [["NO_COLOR", "1"]],
    cwd: tmpDir,
  });

  // read header
  pty.read();

  await write_and_expect(pty, "5+4\n\r", "9");
  await write_and_expect(pty, "let a = 4; a + a\n\r", "8");

  pty.close();
});

Deno.test("multibytes chars work crrectly", async () => {
  const pty = new Pty({
    cmd: "echo",
    args: ["日本語"],
    env: [],
  });

  let success = false;
  while (true) {
    const { data, done } = pty.read();
    await new Promise((r) => setTimeout(r, 100));
    if (done) break;
    if (data?.includes("日本語")) {
      success = true;
      break;
    }
  }
  assert(success);
});
