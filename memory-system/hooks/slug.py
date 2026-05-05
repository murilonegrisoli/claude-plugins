"""Project slug resolution for memory routing.

Maps the current cwd to a project memory directory under
`~/.claude/project-memory/{slug}/`. v0.3.4+ behavior.

Resolution chain (first match wins):

1. Explicit override in `.claude/memory-system.local.md` frontmatter
   (`project_slug:`). Lets users pin the slug regardless of cwd.
2. Walk up from `cwd`; first dir with `.claude-plugin/plugin.json` →
   slug = that dir's name. Handles "user cd'd into a plugin folder".
3. Recent file activity. If `cwd` is at or above the repo root and the
   repo contains plugin subfolders (those with `.claude-plugin/plugin.json`),
   look at the most recent file_path arg in either the about-to-fire tool
   call or the session transcript jsonl. If it's inside a plugin subfolder,
   slug = that plugin's name. Handles "user is at repo root but actively
   editing files in one plugin".
4. Walk up looking for `.git/`; slug = that dir's name. Standard repo root.
5. Fallback: `cwd.name`. Preserves pre-v0.3.4 behavior for layouts where
   no marker exists.
"""
from __future__ import annotations

import json
from pathlib import Path

# Cap how far back we scan the transcript jsonl for recent file edits in step 3.
# 200 events is fine — larger windows risk wrong-plugin-detection on long
# sessions that touched multiple plugins; smaller windows miss recent focus.
TRANSCRIPT_SCAN_LINES = 200


def resolve_slug(
    cwd: Path,
    transcript_path: Path | None = None,
    current_tool_input: dict | None = None,
) -> str:
    """Return the project slug for memory routing.

    `transcript_path` is the session jsonl. Pass when available (Stop hook
    payload includes it; PreToolUse payload also includes it).

    `current_tool_input` is the tool args dict of the about-to-fire tool call.
    Use from PreToolUse hooks for a faster, more recent step-3 signal than
    the transcript scan. Optional.
    """
    # Step 1: explicit override
    override = _read_slug_override(cwd / ".claude" / "memory-system.local.md")
    if override:
        return override

    # Step 2: walk up looking for plugin.json marker
    for d in [cwd, *cwd.parents]:
        if (d / ".claude-plugin" / "plugin.json").is_file():
            return d.name

    # Steps 3 + 4 require knowing the repo root
    repo_root = _find_repo_root(cwd)

    # Step 3: recent file activity
    if repo_root:
        plugin_dirs = _list_plugin_dirs(repo_root)
        if plugin_dirs:
            # Cheaper signal first: current tool input (PreToolUse path)
            if current_tool_input:
                p = _path_from_tool_input(current_tool_input)
                if p:
                    plugin = _matching_plugin(p, plugin_dirs)
                    if plugin:
                        return plugin.name
            # Fall back to transcript jsonl scan
            if transcript_path and transcript_path.is_file():
                plugin = _recent_plugin_from_transcript(transcript_path, plugin_dirs)
                if plugin:
                    return plugin.name

    # Step 4: repo root
    if repo_root:
        return repo_root.name

    # Step 5: fallback
    return cwd.name


def _read_slug_override(config_path: Path) -> str | None:
    """Parse `project_slug:` from a `.claude/memory-system.local.md` frontmatter block."""
    if not config_path.is_file():
        return None
    try:
        content = config_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    in_fm = False
    for line in content.splitlines():
        s = line.strip()
        if s == "---":
            if in_fm:
                break
            in_fm = True
            continue
        if in_fm and s.startswith("project_slug:"):
            return s.split(":", 1)[1].strip().strip('"').strip("'") or None
    return None


def _find_repo_root(start: Path) -> Path | None:
    """Walk up looking for a `.git/` dir. Returns the containing dir or None."""
    for d in [start, *start.parents]:
        if (d / ".git").exists():
            return d
    return None


def _list_plugin_dirs(repo_root: Path) -> list[Path]:
    """Direct subdirs of repo_root that contain `.claude-plugin/plugin.json`."""
    out: list[Path] = []
    try:
        for child in repo_root.iterdir():
            if child.is_dir() and (child / ".claude-plugin" / "plugin.json").is_file():
                out.append(child)
    except OSError:
        pass
    return out


def _matching_plugin(file_path: Path, plugin_dirs: list[Path]) -> Path | None:
    """Return the plugin dir that contains file_path, or None."""
    try:
        resolved = file_path.resolve() if file_path.is_absolute() else file_path
    except (OSError, ValueError):
        return None
    for plugin_dir in plugin_dirs:
        try:
            try:
                resolved_dir = plugin_dir.resolve()
            except OSError:
                resolved_dir = plugin_dir
            if resolved_dir == resolved or resolved_dir in resolved.parents:
                return plugin_dir
        except (OSError, ValueError):
            continue
    return None


def _path_from_tool_input(tool_input: dict) -> Path | None:
    """Extract a path-like field from tool args, if present."""
    for key in ("file_path", "path", "notebook_path"):
        val = tool_input.get(key)
        if isinstance(val, str) and val:
            try:
                return Path(val)
            except ValueError:
                continue
    return None


def _recent_plugin_from_transcript(
    jsonl_path: Path,
    plugin_dirs: list[Path],
) -> Path | None:
    """Scan recent tool_use events for file_path args; return the plugin dir
    containing the most recent matching path, or None.
    """
    try:
        with jsonl_path.open(encoding="utf-8") as f:
            lines = f.readlines()
    except (OSError, UnicodeDecodeError):
        return None

    tail = lines[-TRANSCRIPT_SCAN_LINES:] if len(lines) > TRANSCRIPT_SCAN_LINES else lines
    for line in reversed(tail):
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") != "assistant":
            continue
        msg = obj.get("message") or {}
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            args = block.get("input")
            if not isinstance(args, dict):
                continue
            p = _path_from_tool_input(args)
            if not p:
                continue
            plugin = _matching_plugin(p, plugin_dirs)
            if plugin:
                return plugin
    return None
