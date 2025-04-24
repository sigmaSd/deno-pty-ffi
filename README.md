# Deno Pty FFI

deno wrapper over https://docs.rs/portable-pty/latest/portable_pty/ that exposes
a simple interface

## Usage

```ts
import { Pty } from "jsr:@sigma/pty-ffi";

const pty = new Pty("bash");

// executs ls -la repedetly and shows output
pty.setPollingInterval(500);
for await (const line of pty.readable) {
  console.log(line);
  pty.write("ls -la\n");
}
```
