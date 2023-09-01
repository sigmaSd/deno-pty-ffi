import { Pty } from "./mod.ts";
import { stripColor } from "https://deno.land/std@0.184.0/fmt/colors.ts";

const pty = await Pty.create({
  cmd: "irust",
  args: [],
  env: [["NO_COLOR", "1"]],
});
(async () => {
  while (true) {
    const output = await pty.read();
    if (output) console.log(stripColor(output));
    await new Promise((r) => setTimeout(r, 100));
  }
})();

await new Promise((r) => setTimeout(r, 2000));
await pty.write("5+4\n\r");
// output = await pty.read();
// if (output) console.log(stripColor(output));

await new Promise((r) => setTimeout(r, 2000));
await pty.write(`fn fact(n:usize) -> usize {
      match n {
        0 => 1,
        1 => 1,
        n => n * fact(n-1)
     }
  }\n\r`);
await new Promise((r) => setTimeout(r, 2000));
await pty.write("fact(4)\n\r");
await new Promise((r) => setTimeout(r, 2000));
await pty.write("a\n\r");

// while (true) {
//   const output = await pty.read();
//   if (output) {
//     console.log(
//       stripColor(output),
//     );
//     console.log("###################");
//   }
//   await new Promise((r) => setTimeout(r, 100));
// }

// await pty.write("fact(5)\n\r");

// await reader;
