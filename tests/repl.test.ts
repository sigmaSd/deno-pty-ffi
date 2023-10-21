import { assert } from "https://deno.land/std@0.203.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.203.0/assert/assert_equals.ts";
import { Pty } from "../mod.ts";

// Deno.test("resize", async () => {
//   console.log("b");
//   const pty = await Pty.create({
//     cmd: "deno",
//     args: ["repl"],
//     env: [["NO_COLOR", "1"]],
//   });
//   // test size, resize
//   assertEquals(pty.getSize(), {
//     rows: 24,
//     cols: 80,
//     pixel_height: 0,
//     pixel_width: 0,
//   });
//   pty.resize({
//     rows: 50,
//     cols: 120,
//     pixel_height: 1,
//     pixel_width: 1,
//   });
//   assertEquals(pty.getSize(), {
//     rows: 50,
//     cols: 120,
//     pixel_height: 1,
//     pixel_width: 1,
//   });

//   await pty.close();
//   console.log("done2");
// });

Deno.test("smoke", async () => {
  console.log("a");
  const pty = await Pty.create({
    cmd: "deno",
    args: ["repl"],
    env: [["NO_COLOR", "1"]],
  });
  console.log("az");

  // read header
  await pty.read();

  await write_and_expect(pty, "5+4\n\r", "9");
  await write_and_expect(pty, "let a = 4; a + a\n\r", "8");

  assertEquals(pty.getSize(), {
    rows: 24,
    cols: 80,
    pixel_height: 0,
    pixel_width: 0,
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

  await pty.close();
  console.log("done1");
});

async function write_and_expect(pty: Pty, toWrite: string, expect: string) {
  await pty.write(toWrite);

  let timeoutId;
  const success = await Promise.any([
    // FIXME: in case of timout, this promise reamins alive and it keeps the test form exiting
    (async () => {
      while (1) {
        const r = await pty.read();
        if (r && r.includes(expect)) {
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

  clearTimeout(timeoutId);

  assert(success);
}
