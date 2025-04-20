import { assertEquals } from "jsr:@std/assert@0.220.1";
import { Pty } from "jsr:@sigma/pty-ffi";

Deno.test("multibytes chars work crrectly", () => {
  const pty = new Pty({
    cmd: "echo",
    args: ["日本語"],
    env: [],
  });

  assertEquals(pty.readSync().data, "日本語\r\n");
});
