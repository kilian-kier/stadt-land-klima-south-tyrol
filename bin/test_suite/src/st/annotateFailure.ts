/**
 * Surface log tails as GitHub error annotations. Check-run annotations are readable
 * through the public REST API even when the Actions log itself is not.
 *
 * Usage: node bin/test_suite/src/st/annotateFailure.ts "<title>" <glob> [<glob> ...]
 * GitHub keeps at most 10 error annotations per step and 50 per job; files are
 * reported in argument order, each with a bounded tail.
 */
import { resolve } from "node:path";
import { globSync, readFileSync, statSync } from "node:fs";

const maxAnnotations = 10;
const maxCharacters = 16_000;

export function escapeAnnotation(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A");
}

export function escapeProperty(value: string): string {
  return escapeAnnotation(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** Keep the end of a log, without ANSI sequences, starting at a line boundary. */
export function logTail(text: string, limit = maxCharacters): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  if (clean.length <= limit) return clean.trimEnd();
  const tail = clean.slice(-limit);
  const newline = tail.indexOf("\n");
  return (newline >= 0 && newline < 400 ? tail.slice(newline + 1) : tail).trimEnd();
}

/**
 * GitHub truncates each annotation message to about 4 KB (after %0A escaping), so a log is reported as a few
 * consecutive chunks: the TestRunner failure summary (when present) followed by the end
 * of the log. Returns at most `chunks` messages.
 */
export function annotationChunks(text: string, chunks = 3, size = 3_000): string[] {
  const clean = logTail(text, size * chunks);
  const parts: string[] = [];
  const summary = clean.lastIndexOf("\nFailures:\n");
  if (summary >= 0 && text.includes("================ Test Summary ================"))
    parts.push(clean.slice(summary + 1, summary + 1 + size).trimEnd());
  const remaining = chunks - parts.length;
  const tail = clean.slice(-size * remaining);
  for (let index = 0; index < tail.length; index += size) parts.push(tail.slice(index, index + size));
  return parts.filter((part) => part.trim());
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [title = "Failure", ...patterns] = process.argv.slice(2);
  const files = [...new Set(patterns.flatMap((pattern) => globSync(pattern)))].filter((file) => {
    try {
      return statSync(file).isFile() && statSync(file).size > 0;
    } catch {
      return false;
    }
  });
  if (!files.length) console.log(`No log files matched ${patterns.join(" ")}`);
  let annotations = 0;
  for (const file of files) {
    const parts = annotationChunks(readFileSync(file, "utf8"), files.length > 1 ? 2 : 3);
    for (const [index, part] of parts.entries()) {
      if (annotations++ >= maxAnnotations) break;
      const label = `${title}: ${file.split("/").pop()} (${index + 1}/${parts.length})`;
      console.log(`::error title=${escapeProperty(label)}::${escapeAnnotation(part)}`);
    }
  }
  if (annotations > maxAnnotations) console.log("Annotation limit reached; see the uploaded artifacts.");
}
