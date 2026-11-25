import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const frontend = createRequire(new URL("../../../../src/frontend/package.json", import.meta.url));
type Row = Record<string, any>;

const h3 = {
  defineEventHandler: (fn: unknown) => fn,
  getQuery: (event: Row) => event.query ?? {},
  setResponseHeader() {},
  createError: (options: Row) => Object.assign(new Error(options.statusMessage ?? options.message), options),
};

function load(path: string, dependencies: Row = {}, globals: Row = {}): Row {
  const module = { exports: {} };
  const compiled = ts.transpileModule(
    readFileSync(new URL("../../../../src/frontend/" + path, import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  );
  const requireModule = (id: string): unknown => {
    if (id in dependencies) return dependencies[id];
    if (id === "h3") return h3;
    if (id === "zod") return frontend("zod");
    throw new Error("Unexpected import in " + path + ": " + id);
  };
  runInNewContext(compiled.outputText, {
    module,
    exports: module.exports,
    require: requireModule,
    ...h3,
    Buffer,
    URL,
    URLSearchParams,
    Date,
    process,
    console: { warn() {}, error() {} },
    ...globals,
  });
  return module.exports;
}

test("version endpoint returns release information from runtime config", () => {
  const handler = load(
    "server/api/version.get.ts",
    {},
    {
      useRuntimeConfig: () => ({
        public: {
          releaseCommit: "abc123def456",
          releaseTag: "release-20261122-1",
          releaseBuiltAt: "2026-11-22T10:30:00Z",
        },
      }),
      setHeader: () => {},
    },
  ).default;
  const result = handler({ query: {} });
  assert.equal(result.commit, "abc123def456");
  assert.equal(result.release, "release-20261122-1");
  assert.equal(result.builtAt, "2026-11-22T10:30:00Z");
});

test("version endpoint defaults to unknown when runtime config not set", () => {
  const handler = load(
    "server/api/version.get.ts",
    {},
    {
      useRuntimeConfig: () => ({
        public: {
          releaseCommit: "unknown",
          releaseTag: "unknown",
          releaseBuiltAt: "unknown",
        },
      }),
      setHeader: () => {},
    },
  ).default;
  const result = handler({ query: {} });
  assert.equal(result.commit, "unknown");
  assert.equal(result.release, "unknown");
  assert.equal(result.builtAt, "unknown");
});
