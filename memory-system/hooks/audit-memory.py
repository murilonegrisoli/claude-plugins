#!/usr/bin/env python3
"""memory-system Stop hook — auto-write auditor.

Fires when a Claude Code turn ends. Runs heuristic gates and, if they pass,
spawns a detached worker subprocess that asks Claude (via `claude -p`) to
audit the recent turn and persist anything memo-worthy.

The worker runs in the background; this hook returns immediately so the
user isn't blocked. Loop prevention via the `MEMORY_SYSTEM_AUDITOR=1` env
var: when the worker spawns its own claude subprocess, it sets this var,
and any Stop hook that fires inside that nested session bails immediately.

Output: empty `{continue: true, suppressOutput: true}` payload. Always
exits 0.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()
CLAUDE_HOME = HOME / ".claude"
STATE_DIR = CLAUDE_HOME / "cache" / "memory-system"
AUDIT_STATE_FILE = STATE_DIR / "audit-state.json"

HOOKS_DIR = Path(__file__).resolve().parent
WORKER_SCRIPT = HOOKS_DIR / "memory_auditor" / "worker.py"

# v0.3.4: throttle removed. The dedup gate (`last_audited_turn_id`) already
# prevents re-audit on identical content; the per-session timer was
# delaying confirmations from landing in the audit window. Audits now fire
# on every Stop hook event that has new content.
AUDITOR_ENV_VAR = "MEMORY_SYSTEM_AUDITOR"


def read_input() -> dict:
    try:
        return json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        return {}


def is_recursion() -> bool:
    return os.environ.get(AUDITOR_ENV_VAR) == "1"


def is_disabled_for_project(cwd: Path) -> bool:
    config = cwd / ".claude" / "memory-system.local.md"
    if not config.is_file():
        return False
    try:
        content = config.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    in_fm = False
    for line in content.splitlines():
        s = line.strip()
        if s == "---":
            if in_fm:
                break
            in_fm = True
            continue
        if in_fm and s.startswith("disabled:"):
            return s.split(":", 1)[1].strip().lower() in ("true", "yes", "1")
    return False


def load_state() -> dict:
    if not AUDIT_STATE_FILE.is_file():
        return {"sessions": {}}
    try:
        return json.loads(AUDIT_STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"sessions": {}}


def emit_continue() -> None:
    sys.stdout.write(json.dumps({"continue": True, "suppressOutput": True}))
    sys.exit(0)


def main() -> None:
    data = read_input()
    session_id = data.get("session_id") or ""
    cwd_str = data.get("cwd") or os.getcwd()
    cwd = Path(cwd_str)
    transcript_path = data.get("transcript_path") or ""
    stop_hook_active = data.get("stop_hook_active", False)

    # Gates
    if is_recursion():
        emit_continue()
    if stop_hook_active:
        emit_continue()
    if not session_id or not transcript_path:
        emit_continue()
    if not Path(transcript_path).is_file():
        emit_continue()
    if is_disabled_for_project(cwd):
        emit_continue()

    if not WORKER_SCRIPT.is_file():
        emit_continue()

    # Spawn detached worker
    try:
        env = os.environ.copy()
        env[AUDITOR_ENV_VAR] = "1"
        kwargs: dict = {
            "env": env,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "stdin": subprocess.DEVNULL,
        }
        if sys.platform == "win32":
            DETACHED_PROCESS = 0x00000008
            CREATE_NEW_PROCESS_GROUP = 0x00000200
            kwargs["creationflags"] = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        subprocess.Popen(
            [
                sys.executable,
                str(WORKER_SCRIPT),
                "--session-id", session_id,
                "--transcript", transcript_path,
                "--cwd", str(cwd),
            ],
            **kwargs,
        )
    except Exception:
        pass

    emit_continue()


if __name__ == "__main__":
    main()
