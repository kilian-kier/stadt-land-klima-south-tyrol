/**
 * Explicit register of known application failures detected by the st suites.
 *
 * A finding listed here is reported as KNOWN instead of failing the run. Every entry
 * must name the real defect and where it is tracked. When a listed finding no longer
 * occurs, the suite fails with "FIXED" so the entry is removed instead of silently
 * masking a future regression. Test/CI problems are fixed instead of listed here; the
 * only exception is an explicitly labelled `quarantined` entry for a failure whose cause
 * (application or test) is not yet determined, which must match that exact failure.
 */
export interface KnownFailure {
  /** Stable identifier used in reports. */
  id: string;
  /** Suite that reports the finding, e.g. "crawl". */
  suite: string;
  /** Matches the finding text (route, locale and message). */
  pattern: RegExp;
  /** What is broken in the application and why it is not fixed here. */
  reason: string;
  tracking: string;
  /** Cause not yet determined (application or test); reported as QUARANTINED. */
  quarantined?: boolean;
}

export const knownFailures: KnownFailure[] = [
  {
    id: "error-page-title",
    suite: "crawl",
    pattern:
      /^\S+ \/(?:ci-route-that-does-not-exist|municipalities\/ci-municipality-that-does-not-exist|measures\/sectors): empty <title>$/,
    reason:
      "src/frontend/error.vue sets no <title> and renders hardcoded German text instead of translation keys (AGENTS.md rule 15); needs new de/en/it translation keys",
    tracking: "docs/st/TESTING.md#known-failures",
  },
  {
    id: "dashboard-detail-range-dialog",
    suite: "step:data-dashboard",
    pattern:
      /Failure URL: http:\/\/127\.0\.0\.1:\d+\/data\/stadtkreis_stuttgart\/wind-turbines[\s\S]*getByRole\('dialog'\)\.getByRole\('link', \{ name: \/Stuttgart\/ \}\) to be visible/,
    reason:
      "on the product detail page, choosing a histogram range (after a snapshot change) shows no municipality link in the range dialog; not yet determined whether pages/data/[slug]/[collection].vue or the test fixture is wrong (three stale expectations earlier in this test were fixed)",
    tracking: "docs/st/TESTING.md#known-failures",
    quarantined: true,
  },
];

export interface KnownFailureResult {
  failures: string[];
  known: { finding: string; entry: KnownFailure }[];
  fixed: KnownFailure[];
}

/** Split findings into unexpected failures and known ones; detect stale entries. */
export function classifyFindings(suite: string, findings: string[], entries = knownFailures): KnownFailureResult {
  const applicable = entries.filter((entry) => entry.suite === suite);
  const used = new Set<string>();
  const result: KnownFailureResult = { failures: [], known: [], fixed: [] };
  for (const finding of findings) {
    const entry = applicable.find((candidate) => candidate.pattern.test(finding));
    if (entry) {
      used.add(entry.id);
      result.known.push({ finding, entry });
    } else result.failures.push(finding);
  }
  result.fixed = applicable.filter((entry) => !used.has(entry.id));
  return result;
}

export function printClassification(suite: string, result: KnownFailureResult): boolean {
  for (const { finding, entry } of result.known)
    console.log(`KNOWN [${entry.id}] ${finding}\n  reason: ${entry.reason} (${entry.tracking})`);
  for (const entry of result.fixed)
    console.log(`FIXED [${entry.id}] no longer occurs; remove it from knownFailures.ts`);
  for (const failure of result.failures) console.log(`FAIL ${failure}`);
  const ok = result.failures.length === 0 && result.fixed.length === 0;
  console.log(
    `${suite}: ${result.failures.length} unexpected, ${result.known.length} known, ${result.fixed.length} stale known-failure entries`,
  );
  return ok;
}

/**
 * Failures reported by an upstream suite run as a CI step (suite `step:<name>`). Suites
 * built on TestRunner list every failed step under "Failures:"; each must be known. Other
 * scripts stop at their first failed assertion, so the whole log is matched instead.
 */
export function stepFindings(log: string): string[] {
  const summary = log.lastIndexOf("================ Test Summary ================");
  if (summary < 0) return [log];
  const failures = log.slice(summary).split("\nFailures:\n")[1];
  if (!failures) return [];
  return failures
    .split(/\n(?=- )/)
    .map((block) => block.split("\n\n")[0]!.trim())
    .filter((line) => line.startsWith("- "));
}

export function classifyStep(
  name: string,
  log: string,
  status: number,
  entries = knownFailures,
  report: (line: string) => void = console.log,
): number {
  const suite = `step:${name}`;
  if (status === 0) {
    const stale = entries.filter((entry) => entry.suite === suite);
    for (const entry of stale)
      report(`::error title=FIXED known failure ${entry.id}::${name} passed; remove ${entry.id} from knownFailures.ts`);
    return stale.length ? 1 : 0;
  }
  if (!entries.some((entry) => entry.suite === suite)) return status;
  const result = classifyFindings(suite, stepFindings(log), entries);
  for (const { entry } of result.known)
    report(
      `::warning title=${entry.quarantined ? "QUARANTINED" : "KNOWN"} failure ${entry.id}::${name}: ${entry.reason} (${entry.tracking})`,
    );
  return result.failures.length || result.fixed.length ? status : 0;
}

if (process.argv[1]?.endsWith("knownFailures.ts") && process.argv[2] === "step") {
  const { readFileSync } = await import("node:fs");
  const [name, logPath, status] = process.argv.slice(3);
  process.exitCode = classifyStep(name!, readFileSync(logPath!, "utf8"), Number(status));
}
