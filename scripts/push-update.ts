#!/usr/bin/env -S deno -A

// deno-lint-ignore-file no-import-prefix
import { $ } from "jsr:@david/dax@0.43.2";
import { format, increment, parse } from "jsr:@std/semver@1.0.5";
import metadata from "../deno.json" with { type: "json" };
import type { ReleaseType } from "jsr:@std/semver@1.0.5/types";

function assertIsAReleaseType(
  value: string | undefined,
): asserts value is ReleaseType {
  if (!(value === "major" || value === "minor" || value === "patch")) {
    console.error(
      `Invalid release type: ${value}. Must be major, minor, or patch.`,
    );
    Deno.exit(1);
  }
}

const releaseType = Deno.args[0];
assertIsAReleaseType(releaseType);

const currentVersion = parse(metadata.version);
const nextVersion = increment(currentVersion, releaseType);

console.log(
  `Updating version from ${format(currentVersion)} to ${format(nextVersion)}`,
);

if (!confirm("continue ?")) {
  Deno.exit(0);
}

console.log("Updating deno.json");
Deno.writeTextFileSync(
  "deno.json",
  JSON.stringify(
    {
      ...metadata,
      version: format(nextVersion),
    },
    null,
    2,
  ),
);

$.setPrintCommand(true);
await $`git add -A`;
await $`git commit -m ${format(nextVersion)}`;
await $`git tag -a ${format(nextVersion)} -m ${format(nextVersion)}`;
await $`git push --follow-tags`;
