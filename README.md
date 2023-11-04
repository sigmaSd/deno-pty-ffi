# Deno Pty FFI

deno wrapper over https://docs.rs/portable-pty/latest/portable_pty/ that exposes
a simple interface

## Usage

This module requires `--unstable-ffi`

```ts
import { Pty } from "https://deno.land/x/deno_pty_ffi/mod.ts";

const pty = new Pty({
  cmd: "bash",
  args: [],
  env: [],
});

// executs ls -la repedetly and shows output
while (true) {
  await pty.write("ls -la\n");
  console.log(await pty.read());
  await new Promise((r) => setTimeout(r, 100));
}
```
