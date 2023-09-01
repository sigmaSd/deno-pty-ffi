t(() => Deno.readFileSync("doesntexist"));
t(() => Deno.env.get("doesntexist"));

function t(e: () => void) {
  try {
    e();
  } catch {
    /*its cool*/
  }
}
