#!/usr/bin/env python3
"""memory-system PreToolUse hook.

Inject project MEMORY.md and the global memory index into the session context
at session-relevant boundaries:

  1. The very first tool call of a session (covers the main session).
  2. Any tool call that immediately follows an `Agent` tool call (covers
     subagent sessions, which inherit the parent's session_id and so can't be
     distinguished by id alone — we use the `Agent` boundary as a proxy).
  3. Any tool call where a watched memory file's mtime is newer than the
     session's last inject — covers the case where memory was written mid-
     session (by this session, a concurrent session, or the user) and would
     otherwise stay stale until the next session.

Subsequent tool calls in the same flow stay silent so the additionalContext
isn't re-emitted on every Read/Bash/Edit.

Output: JSON with `hookSpecificOutput.additionalContext` on stdout. Always
exits 0.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Sibling slug resolver. inject-memory.py runs as a script from
# `${CLAUDE_PLUGIN_ROOT}/hooks/`, so Python's sys.path[0] already covers
# this dir — no manipulation needed.
from slug import resolve_slug

HOME = Path.home()
CLAUDE_HOME = HOME / ".claude"
GLOBAL_INDEX = CLAUDE_HOME / "memory" / "MEMORY.md"
PROJECT_MEMORY_ROOT = CLAUDE_HOME / "project-memory"
STATE_DIR = CLAUDE_HOME / "cache" / "memory-system"
STATE_FILE = STATE_DIR / "state.json"

SESSION_TTL_DAYS = 7


def read_input() -> dict:
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return {}


def is_disabled_for_project(cwd: Path) -> bool:
    config_file = cwd / ".claude" / "memory-system.local.md"
    if not config_file.is_file():
        return False
    try:
        content = config_file.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False

    in_frontmatter = False
    for line in content.splitlines():
        stripped = line.strip()
        if stripped == "---":
            if in_frontmatter:
                break
            in_frontmatter = True
            continue
        if in_frontmatter and stripped.startswith("disabled:"):
            value = stripped.split(":", 1)[1].strip().lower()
            return value in ("true", "yes", "1")
    return False


def load_state() -> dict:
    if not STATE_FILE.is_file():
        return {"sessions": {}}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"sessions": {}}


def save_state(state: dict) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = STATE_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
        os.replace(tmp, STATE_FILE)
    except OSError:
        pass


def prune_old_sessions(state: dict) -> dict:
    cutoff = time.time() - (SESSION_TTL_DAYS * 86400)
    sessions = state.get("sessions", {})
    state["sessions"] = {
        sid: info
        for sid, info in sessions.items()
        if info.get("last_seen_epoch", info.get("first_seen_epoch", 0)) >= cutoff
    }
    return state


def _max_mtime_in_tree(root: Path, current: float) -> float:
    """Return max(current, max mtime of any `.md` under root)."""
    try:
        if not root.is_dir():
            return current
        for md in root.rglob("*.md"):
            try:
                current = max(current, md.stat().st_mtime)
            except OSError:
                continue
    except OSError:
        pass
    return current


def watched_max_mtime(slug: str) -> float:
    """Latest mtime across all watched memory files.

    Watches the entire project memory tree (`~/.claude/project-memory/{slug}/**/*.md`)
    and the entire global memory tree (`~/.claude/memory/**/*.md`). The hook
    only injects MEMORY.md (the index), but bumping mtime on any topic file
    typically coincides with a skill-driven index update — watching the whole
    tree just provides safety against missed index bumps.
    """
    max_mtime = 0.0
    max_mtime = _max_mtime_in_tree(PROJECT_MEMORY_ROOT / slug, max_mtime)
    max_mtime = _max_mtime_in_tree(CLAUDE_HOME / "memory", max_mtime)
    return max_mtime


def read_text_safe(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def compose_message(slug: str) -> str:
    project_path = PROJECT_MEMORY_ROOT / slug / "MEMORY.md"
    project_content = read_text_safe(project_path)

    parts: list[str] = []

    if project_content is not None:
        parts.append(f"=== Project MEMORY.md (`{slug}`) ===\n{project_content.strip()}")
    else:
        parts.append(f"(no project MEMORY.md for `{slug}` at {project_path})")

    index_content = read_text_safe(GLOBAL_INDEX)
    if index_content is not None:
        parts.append(f"=== Global Memory Index ===\n{index_content.strip()}")

    return "\n\n".join(parts)


def emit(context: str | None) -> None:
    if context:
        payload = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "additionalContext": context,
            }
        }
    else:
        payload = {"continue": True, "suppressOutput": True}
    sys.stdout.write(json.dumps(payload))
    sys.exit(0)


def main() -> None:
    data = read_input()
    session_id = data.get("session_id") or ""
    cwd_str = data.get("cwd") or os.getcwd()
    cwd = Path(cwd_str)
    tool_name = data.get("tool_name") or ""
    transcript_path_str = data.get("transcript_path") or ""
    tool_input = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else None

    if not session_id:
        emit(None)

    if is_disabled_for_project(cwd):
        emit(None)

    transcript_path = Path(transcript_path_str) if transcript_path_str else None
    slug = resolve_slug(cwd, transcript_path=transcript_path, current_tool_input=tool_input)

    state = load_state()
    sessions = state.setdefault("sessions", {})
    info = sessions.get(session_id)
    now_epoch = time.time()

    should_inject = False
    if info is None:
        # First tool call ever in this session — inject.
        should_inject = True
        info = {
            "first_seen": datetime.now(timezone.utc).isoformat(),
            "first_seen_epoch": now_epoch,
        }
    elif info.get("last_was_agent") and tool_name != "Agent":
        # Previous tool was Agent (subagent likely spawned). Current tool isn't
        # Agent, so this is plausibly the subagent's first tool call. Re-inject
        # to make memory visible inside the subagent context.
        should_inject = True
    elif info.get("last_slug") != slug:
        # Slug resolution changed mid-session (e.g. user cd'd into a plugin
        # subfolder, or recent file activity shifted focus). Re-inject so
        # the new project's memory becomes visible.
        should_inject = True
    elif watched_max_mtime(slug) > info.get("last_inject_epoch", 0):
        # Watched memory file changed since our last inject — re-inject so the
        # session sees the fresh content.
        should_inject = True

    info["last_was_agent"] = (tool_name == "Agent")
    info["last_seen_epoch"] = now_epoch
    info["last_slug"] = slug
    if should_inject:
        info["last_inject_epoch"] = now_epoch
    sessions[session_id] = info
    state = prune_old_sessions(state)
    save_state(state)

    emit(compose_message(slug) if should_inject else None)


if __name__ == "__main__":
    main()
