import { Pty } from "./mod.ts";

if (Deno.args.length === 0) throw new Error("no program provided");

const pty = await Pty.create({
  cmd: "deno",
  args: ["run", ...Deno.args],
  env: [["NO_COLOR", "1"]],
});

type Permission = "read" | "write" | "net" | "env";
const permissions: Record<Permission, string[]> = {
  read: [],
  write: [],
  net: [],
  env: [],
};

Deno.addSignalListener("SIGINT", () => {
  console.log("\nPermissions:");
  console.log(permissions);
  console.log("Command:");
  console.log(
    "deno run " +
      (
        permissions.read ? "--allow-read=" + permissions.read : ""
      ) + " " +
      (
        permissions.write ? "--allow-write=" + permissions.write : ""
      ) + " " +
      (
        permissions.net ? "--allow-net=" + permissions.net : ""
      ) + " " +
      (
        permissions.env ? "--allow-env=" + permissions.env : ""
      ),
  );
  Deno.exit();
});

while (true) {
  const line = await pty.read();
  if (!line) break;
  // console.log(line);

  if (line.includes("Granted") && line.includes("access")) {
    const line_split = line.split(/\s+/);
    const mark = line_split.indexOf("access");
    const permission_type = line_split[mark - 1] as Permission;
    let permission = line_split[mark + 2].slice(1, -2);

    switch (permission) {
      case "CWD":
        permission = Deno.cwd();
        break;
      case "TMP":
        permission = pty.tmpDir();
        break;
    }

    console.log(permission_type, permission);
    permissions[permission_type].push(permission);
  }

  if (line.includes("Allow?")) {
    await pty.write("y\n");
  }
}
