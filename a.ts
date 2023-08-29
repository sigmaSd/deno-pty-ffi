import { Pty } from "./mod.ts";

const pty = await Pty.create({
  cmd: "ls",
  args: [],
  env: [],
});

console.log(await pty.read());
console.log(await pty.read());
console.log(await pty.read());
console.log(await pty.read());
console.log(await pty.read());
console.log(await pty.read());
