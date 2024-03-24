import { assert } from "https://deno.land/std@0.203.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.203.0/assert/assert_equals.ts";
import { Pty } from "../mod.ts";

Deno.test("smoke", async () => {
  const jobs = [];
  for (let i = 0; i < 10; i++) {
    jobs.push((async () => {
      const pty = new Pty({
        cmd: "deno",
        args: ["repl"],
        env: [["NO_COLOR", "1"]],
      });

      // read header
      await pty.read();

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
    })());
  }
  await Promise.all(jobs);
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

async function write_and_expect(pty: Pty, toWrite: string, expect: string) {
  await pty.write(toWrite);

  let timeoutId: number | undefined = undefined;
  const success = await Promise.any([
    // FIXME: in case of timout, this promise reamins alive and it keeps the test form exiting
    (async () => {
      while (true) {
        const { data: r, done } = await pty.read();
        if (done) break;
        if (r?.includes(expect)) {
          return true;
        }
      }
    })(),
    (async () => {
      await new Promise((r) => {
        timeoutId = setTimeout(r, 5000);
      });
      return false;
    })(),
  ]);

  if (timeoutId !== undefined) clearTimeout(timeoutId);

  assert(success);
}
