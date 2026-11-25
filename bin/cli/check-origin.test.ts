import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkPlan, releaseOrigin, type PlanOptions } from "./check-plan.ts";

const release: PlanOptions = { profile: "release", only: [], reportDirectory: join(tmpdir(), "slk-check-origin") };

test("release checks accept one explicit origin of another deployment", () => {
  const plan = checkPlan({ ...release, origin: "https://www.example.org" });
  assert.deepEqual(
    plan.map((check) => check.id),
    ["runtime", "public", "csp", "styles"],
  );
  assert.ok(plan.slice(1).every((check) => check.args.at(-1) === "https://www.example.org"));
  assert.equal(releaseOrigin("http://127.0.0.1:9000/"), "http://127.0.0.1:9000");
  assert.equal(releaseOrigin("https://www.example.org:8443"), "https://www.example.org:8443");
});

test("release origins refuse plain HTTP, credentials, paths and ambiguous targets", () => {
  for (const origin of [
    "http://www.example.org",
    "https://user:secret@www.example.org",
    "https://www.example.org/path",
    "https://www.example.org/?query",
    "https://www.example.org/#fragment",
    "not a url",
  ])
    assert.throws(() => checkPlan({ ...release, origin }), /--origin must/);
  assert.throws(
    () => checkPlan({ ...release, target: "staging", origin: "https://www.example.org" }),
    /either --target or --origin/,
  );
  assert.throws(
    () => checkPlan({ ...release, profile: "quality", origin: "https://www.example.org" }),
    /only supported by release/,
  );
  assert.throws(() => checkPlan(release), /requires --target/);
});
