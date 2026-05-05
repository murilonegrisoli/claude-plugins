import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Create a fresh tmp directory for the test. Caller is responsible for cleanup
 * via `removeTree(dir)` (typically in `afterEach`).
 *
 * @param {string} [prefix]
 */
export function makeTmpDir(prefix = "memsys-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Write a file, creating parent dirs as needed.
 * @param {string} filePath
 * @param {string} content
 */
export function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

/** @param {string} dir */
export function removeTree(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Write a transcript jsonl from an array of events.
 * @param {string} filePath
 * @param {Array<Record<string, unknown>>} events
 */
export function writeJsonl(filePath, events) {
  const content = events.map((e) => JSON.stringify(e)).join("\n");
  writeFile(filePath, content);
}
