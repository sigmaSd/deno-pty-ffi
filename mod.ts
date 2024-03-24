/**
# Deno Pty FFI

deno wrapper over https://docs.rs/portable-pty/latest/portable_pty/ that exposes
a simple interface

## Usage

This module requires `--unstable-ffi`

```ts
import * as mod from "jsr:@sigma/pty-ffi";

const pty = new Pty({
  cmd: "bash",
  args: [],
  env: [],
});

// executs ls -la repedetly and shows output
while (true) {
  await pty.write("ls -la\n");
  const { data, done } = await pty.read();
  if (done) break;
  console.log(data);
  await new Promise((r) => setTimeout(r, 100));
}
```

@module
*/
export { Pty } from "./src/mod.ts";
export type { Command, PtySize } from "./src/ffi.ts";
