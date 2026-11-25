import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { databaseShell } from "./host-backup.ts";

const run = (path: string, script: string, ...args: string[]) => {
  const [command, ...rest] = databaseShell(script, ...args);
  return execFileSync(command!, rest, { encoding: "utf8", env: { PATH: path } });
};

test(
  "database dumps load the mounted environment when the container has a loader",
  { skip: process.platform === "win32" },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "slk-loader-"));
    try {
      // Without slk-env the script runs directly (native-secret containers), keeping positional arguments.
      assert.equal(
        run("/usr/bin:/bin", 'printf "%s:%s" "${POSTGRES_USER:-none}" "$1"', "_", "directus"),
        "none:directus",
      );
      writeFileSync(join(directory, "slk-env"), '#!/bin/sh\nPOSTGRES_USER=mounted exec "$@"\n');
      chmodSync(join(directory, "slk-env"), 0o755);
      assert.equal(
        run(`${directory}:/usr/bin:/bin`, 'printf "%s:%s" "${POSTGRES_USER:-none}" "$1"', "_", "directus"),
        "mounted:directus",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
