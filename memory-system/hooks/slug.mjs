/**
 * @file Project slug resolution for memory routing.
 *
 * Maps the current cwd to a project memory directory under
 * `~/.claude/project-memory/{slug}/`. Ported from slug.py for v0.4.0.
 *
 * Resolution chain (first match wins):
 *
 *   1. Explicit override in `.claude/memory-system.local.md` frontmatter
 *      (`project_slug:`). Lets users pin the slug regardless of cwd.
 *   2. Walk up from `cwd`; first dir with `.claude-plugin/plugin.json` →
 *      slug = that dir's name. Handles "user cd'd into a plugin folder".
 *   3. Recent file activity. If `cwd` is at or above the repo root and the
 *      repo contains plugin subfolders, look at the most recent file_path
 *      arg in either the about-to-fire tool call or the session transcript
 *      jsonl. If it's inside a plugin subfolder, slug = that plugin's name.
 *   4. Walk up looking for `.git/`; slug = that dir's name.
 *   5. Fallback: basename of cwd.
 */
import fs from "node:fs";
import path from "node:path";

// Cap how far back we scan the transcript jsonl for recent file edits in step 3.
// 200 events is fine — larger windows risk wrong-plugin-detection on long
// sessions that touched multiple plugins; smaller windows miss recent focus.
const TRANSCRIPT_SCAN_LINES = 200;

/**
 * Yield each ancestor dir (start first), walking up to the filesystem root.
 * @param {string} start
 * @returns {string[]}
 */
function ancestorDirs(start) {
  const out = [start];
  let cur = start;
  while (true) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

/** @param {string} p */
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** @param {string} p */
function pathExists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the project slug for memory routing.
 *
 * `transcriptPath` is the session jsonl. Pass when available (Stop hook
 * payload includes it; PreToolUse payload also includes it).
 *
 * `currentToolInput` is the tool args dict of the about-to-fire tool call.
 * Use from PreToolUse hooks for a faster, more recent step-3 signal than
 * the transcript scan. Optional.
 *
 * @param {string} cwd
 * @param {{ transcriptPath?: string | null, currentToolInput?: Record<string, unknown> | null }} [opts]
 * @returns {string}
 */
export function resolveSlug(cwd, opts = {}) {
  const { transcriptPath = null, currentToolInput = null } = opts;

  // Step 1: explicit override
  const override = readSlugOverride(path.join(cwd, ".claude", "memory-system.local.md"));
  if (override) return override;

  // Step 2: walk up looking for plugin.json marker
  for (const d of ancestorDirs(cwd)) {
    if (isFile(path.join(d, ".claude-plugin", "plugin.json"))) {
      return path.basename(d);
    }
  }

  // Steps 3 + 4 require knowing the repo root
  const repoRoot = findRepoRoot(cwd);

  // Step 3: recent file activity
  if (repoRoot) {
    const pluginDirs = listPluginDirs(repoRoot);
    if (pluginDirs.length > 0) {
      // Cheaper signal first: current tool input (PreToolUse path)
      if (currentToolInput) {
        const p = pathFromToolInput(currentToolInput);
        if (p) {
          const plugin = matchingPlugin(p, pluginDirs);
          if (plugin) return path.basename(plugin);
        }
      }
      // Fall back to transcript jsonl scan
      if (transcriptPath && isFile(transcriptPath)) {
        const plugin = recentPluginFromTranscript(transcriptPath, pluginDirs);
        if (plugin) return path.basename(plugin);
      }
    }
  }

  // Step 4: repo root
  if (repoRoot) return path.basename(repoRoot);

  // Step 5: fallback
  return path.basename(cwd);
}

/**
 * Parse `project_slug:` from a `.claude/memory-system.local.md` frontmatter block.
 * @param {string} configPath
 * @returns {string | null}
 */
function readSlugOverride(configPath) {
  if (!isFile(configPath)) return null;
  let content;
  try {
    content = fs.readFileSync(configPath, "utf-8");
  } catch {
    return null;
  }
  let inFm = false;
  for (const line of content.split(/\r?\n/)) {
    const s = line.trim();
    if (s === "---") {
      if (inFm) break;
      inFm = true;
      continue;
    }
    if (inFm && s.startsWith("project_slug:")) {
      const raw = s.slice("project_slug:".length).trim();
      const stripped = raw.replace(/^["']|["']$/g, "");
      return stripped || null;
    }
  }
  return null;
}

/**
 * Walk up looking for a `.git/` entry (file or dir). Returns the containing dir or null.
 * @param {string} start
 * @returns {string | null}
 */
function findRepoRoot(start) {
  for (const d of ancestorDirs(start)) {
    if (pathExists(path.join(d, ".git"))) return d;
  }
  return null;
}

/**
 * Direct subdirs of `repoRoot` that contain `.claude-plugin/plugin.json`.
 * @param {string} repoRoot
 * @returns {string[]}
 */
function listPluginDirs(repoRoot) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(repoRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const child = path.join(repoRoot, ent.name);
    if (isFile(path.join(child, ".claude-plugin", "plugin.json"))) {
      out.push(child);
    }
  }
  return out;
}

/**
 * Return the plugin dir that contains `filePath`, or null.
 * @param {string} filePath
 * @param {string[]} pluginDirs
 * @returns {string | null}
 */
function matchingPlugin(filePath, pluginDirs) {
  const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : filePath;
  for (const pluginDir of pluginDirs) {
    let resolvedDir;
    try {
      resolvedDir = path.resolve(pluginDir);
    } catch {
      resolvedDir = pluginDir;
    }
    if (resolvedDir === resolved) return pluginDir;
    if (resolved.startsWith(resolvedDir + path.sep)) return pluginDir;
  }
  return null;
}

/**
 * Extract a path-like field from tool args, if present.
 * @param {Record<string, unknown>} toolInput
 * @returns {string | null}
 */
function pathFromToolInput(toolInput) {
  for (const key of ["file_path", "path", "notebook_path"]) {
    const val = toolInput[key];
    if (typeof val === "string" && val) return val;
  }
  return null;
}

/**
 * Scan recent tool_use events for file_path args; return the plugin dir
 * containing the most recent matching path, or null.
 * @param {string} jsonlPath
 * @param {string[]} pluginDirs
 * @returns {string | null}
 */
function recentPluginFromTranscript(jsonlPath, pluginDirs) {
  let content;
  try {
    content = fs.readFileSync(jsonlPath, "utf-8");
  } catch {
    return null;
  }
  const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
  const tail = lines.length > TRANSCRIPT_SCAN_LINES ? lines.slice(-TRANSCRIPT_SCAN_LINES) : lines;

  for (let i = tail.length - 1; i >= 0; i--) {
    let obj;
    try {
      obj = JSON.parse(tail[i]);
    } catch {
      continue;
    }
    if (!obj || obj.type !== "assistant") continue;
    const blocks = obj.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!block || typeof block !== "object" || block.type !== "tool_use") continue;
      const args = block.input;
      if (!args || typeof args !== "object") continue;
      const p = pathFromToolInput(/** @type {Record<string, unknown>} */ (args));
      if (!p) continue;
      const plugin = matchingPlugin(p, pluginDirs);
      if (plugin) return plugin;
    }
  }
  return null;
}
