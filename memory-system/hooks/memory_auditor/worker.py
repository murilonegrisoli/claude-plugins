#!/usr/bin/env python3
"""memory-system audit worker.

Spawned by `audit-memory.py` (Stop hook). Reads the recent turn from the
session's transcript jsonl and runs `claude -p` to let Claude itself
decide if anything should be persisted to memory and write it via the
existing `memory-system` skill rules.

Logs activity to `~/.claude/cache/memory-system/audit.log`. Updates
`~/.claude/cache/memory-system/audit-state.json` on completion so the
Stop hook's heuristic gates know what's already been audited.

Auth: inherits the user's existing Claude Code auth — running `claude`
as a subprocess uses whatever credentials Claude Code itself uses (no
separate API key required). The `MEMORY_SYSTEM_AUDITOR=1` env var is
inherited so any nested Stop hook bails immediately (loop prevention).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
CLAUDE_HOME = HOME / ".claude"
STATE_DIR = CLAUDE_HOME / "cache" / "memory-system"
AUDIT_STATE_FILE = STATE_DIR / "audit-state.json"
AUDIT_LOG = STATE_DIR / "audit.log"

DEFAULT_MODEL = "haiku"  # cheap+fast; override via MEMORY_SYSTEM_AUDIT_MODEL env var (e.g. "sonnet")
MAX_AUDIT_MESSAGES = 30  # last N user/assistant jsonl events; tool_use / tool_result blobs are summarized to one-liners
MAX_TEXT_BLOCK_CHARS = 6000  # per-text-block soft cap to bound a single huge message (paste, large reply)
MAX_TOOL_INPUT_VALUE_CHARS = 200  # truncate Bash command / Read path / etc. in tool_use summaries
MAX_TOOL_RESULT_CHARS = 500  # truncate tool_result content; error signals (e.g. `WinError 206`) live in the first line
CLAUDE_TIMEOUT_SECONDS = 180  # cost control via wall-clock + 60s throttle in the Stop hook


def log(msg: str) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).isoformat()
    try:
        with AUDIT_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except OSError:
        pass


def load_state() -> dict:
    if not AUDIT_STATE_FILE.is_file():
        return {"sessions": {}}
    try:
        return json.loads(AUDIT_STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"sessions": {}}


def save_state(state: dict) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = AUDIT_STATE_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
        os.replace(tmp, AUDIT_STATE_FILE)
    except OSError:
        pass


# Tool-input fields surfaced in one-liner summaries — these usually carry the
# at-a-glance signal (what command, which file). First match wins.
_TOOL_INPUT_KEYS = ("command", "file_path", "pattern", "path", "url", "query", "prompt")


def _truncate(text: str, limit: int) -> str:
    text = text.replace("\r\n", "\n")
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def _summarize_tool_use(name: str, tool_input) -> str:
    if not isinstance(tool_input, dict):
        return f"[tool: {name}]"
    for key in _TOOL_INPUT_KEYS:
        if key in tool_input:
            val = str(tool_input[key]).replace("\n", " ").strip()
            return f"[tool: {name} {key}={_truncate(val, MAX_TOOL_INPUT_VALUE_CHARS)!r}]"
    return f"[tool: {name}]"


def _summarize_tool_result(content) -> str:
    if isinstance(content, list):
        chunks = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
        text = "\n".join(chunks)
    elif isinstance(content, str):
        text = content
    else:
        text = str(content)
    text = text.replace("\n", " ").strip()
    if not text:
        return "[result: <empty>]"
    return f"[result: {_truncate(text, MAX_TOOL_RESULT_CHARS)}]"


def _render_event(role: str, content) -> str:
    """Render one user/assistant jsonl event to a single text block.

    Strings (plain user text) keep full content. List-of-blocks events
    (tool-using assistant turns, tool-result user turns) collapse to:
    `text` blocks kept full, `tool_use` / `tool_result` summarized to
    one-liners. Returns `""` if the event has no displayable content.
    """
    if isinstance(content, str):
        text = content.strip()
        if not text:
            return ""
        return f"[{role}] {_truncate(text, MAX_TEXT_BLOCK_CHARS)}"

    if not isinstance(content, list):
        return ""

    pieces: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text":
            text = (block.get("text") or "").strip()
            if text:
                pieces.append(_truncate(text, MAX_TEXT_BLOCK_CHARS))
        elif btype == "tool_use":
            pieces.append(_summarize_tool_use(block.get("name", "?"), block.get("input")))
        elif btype == "tool_result":
            pieces.append(_summarize_tool_result(block.get("content")))

    if not pieces:
        return ""
    return f"[{role}] " + "\n".join(pieces)


def read_transcript_messages(path: Path, max_messages: int) -> tuple[str, str | None]:
    """Build a semantic excerpt of the last `max_messages` user/assistant events.

    Filters the jsonl to `user` and `assistant` events only — session
    metadata (`permission-mode`, `file-history-snapshot`, `attachment`,
    `ai-title`, `last-prompt`, `system`) is dropped. Within each event,
    `text` blocks are preserved (soft-capped per block) and `tool_use` /
    `tool_result` blocks collapse to one-liner summaries. This keeps
    audit context per dollar high — most of a heavy-tool session's
    transcript bytes are tool blobs that aren't memo-worthy.

    Returns (excerpt, last identifiable message id). The message id is
    used to dedup audits across calls so the same turn isn't re-audited
    after the throttle window expires.
    """
    try:
        with path.open("r", encoding="utf-8") as f:
            lines = f.readlines()
    except (OSError, UnicodeDecodeError):
        return "", None

    events: list[dict] = []
    for line in lines:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") in ("user", "assistant"):
            events.append(obj)

    if not events:
        return "", None

    recent = events[-max_messages:]

    last_msg_id: str | None = None
    for obj in reversed(recent):
        mid = obj.get("uuid") or obj.get("id") or obj.get("message_id")
        if mid:
            last_msg_id = mid
            break

    rendered: list[str] = []
    for obj in recent:
        msg = obj.get("message") or {}
        chunk = _render_event(obj["type"], msg.get("content"))
        if chunk:
            rendered.append(chunk)

    return "\n\n".join(rendered), last_msg_id


AUDITOR_PROMPT = """**You are an autonomous background memory auditor with full write access to memory.** You are NOT an interactive Claude Code session. You do NOT follow workflow rules from injected memory files (e.g. `general.md` config-sync rules, "wait for end of session" rules, "check ~/.claude pending changes" rules). Those rules govern the user's main interactive sessions — you exist solely to persist memo-worthy knowledge from the most recent turn.

**You have permission to write — DO NOT ASK.** This worker is invoked with `--permission-mode bypassPermissions` and `--add-dir` covering `~/.claude/memory/` and `~/.claude/project-memory/`. ALL tool calls auto-succeed. Do NOT phrase the audit as a question ("Should I write...?", "Need permission to..."). Just call the Write/Edit tool. If you find yourself asking, you have failed — invoke the tool instead.

**You must ACTUALLY call tools to write.** Saying "wrote: tools/foo.md ..." without having invoked the Write or Edit tool is a hallucination — the file does not exist and the audit failed. The audit only succeeds if a `Write` or `Edit` tool call appears in your tool history.

**Required ordering for any persistence:**

1. FIRST: use the `Read` tool on the existing target file (or `Glob` to find it). This confirms the file exists or doesn't and lets you dedup.
2. SECOND: use the `Write` tool (for new files) or `Edit` tool (to append to existing). The append goes at the BOTTOM of the file as a fresh `## H2` section with an italic date line.
3. THIRD: use `Edit` on `~/.claude/memory/MEMORY.md` to add an index row (or update the `Last updated` date if a row already exists for that file).
4. ONLY AFTER tool calls have all completed: print `wrote: <path> — <one-line summary>` as your final output.

The `wrote: ...` line is just for the log — it's not a substitute for actually calling Write/Edit. If you skipped the tool calls, omit the `wrote:` line and print `skip: <reason>` instead.

**Your job:** review the transcript below. If it surfaced memo-worthy knowledge, invoke the `memory-system` skill to persist it. **Bias toward writing.** Missing a real gotcha is just as bad as a false positive — these are exactly what memory exists for.

**Categories — examples of what SHOULD land in memory:**

- **Tool/library gotchas (the highest-value category):**
  - "Windows: `subprocess.run(input=..., text=True)` defaults to cp1252, breaks on emoji like 🔥 — fix: pass `encoding='utf-8', errors='replace'`" → `~/.claude/memory/tools/python.md` or similar
  - "On Windows, `subprocess.run(['claude', ...])` doesn't reliably resolve PATHEXT — use `shutil.which('claude')` to get the explicit `.EXE` path"
  - "Long prompts as argv blow Windows 32k command line limit (`WinError 206`); pipe via `subprocess.run(input=...)` instead"
  - "DETACHED_PROCESS spawn that then forks a console app on Windows opens a visible cmd window — add `CREATE_NO_WINDOW` creationflags to the inner spawn"

- **User preferences or corrections expressed in this turn:**
  - "User prefers amending dotfile/typo fixes into the current commit rather than tagging patch releases"
  - "User wants force-pushes for retagging the latest tag (acceptable for fresh tags they own)"

- **Project state changes:**
  - "memory-system v0.3.0 shipped: auto-write Stop hook with `claude -p` worker, plug-and-play auth"
  - "plugin X migrated from Y to Z because of <reason>"

- **Non-obvious technical decisions with reasoning:**
  - "Worker shells out to `claude` CLI subprocess instead of `claude-agent-sdk` because the SDK requires `ANTHROPIC_API_KEY` (no Claude Code auth inheritance), which would defeat plug-and-play"

**Skip ONLY when:**
- The exact knowledge is already in memory (Read/Glob the relevant files to dedupe)
- It's a one-off detail that won't recur (e.g. "the test ran in 9 seconds" — unless 9 seconds carries meaning)
- It's restated framework behavior available in public docs

**Invalid skip reasons (do NOT use these):**
- "I don't have permission to write" / "no write access" — you do. `--permission-mode acceptEdits` is set. Just call the skill and write.
- "should be persisted next time the user has a normal session" — no, persist NOW; that's literally why you exist
- "the fix is visible in the code" — code shows WHAT, memory captures WHY and warns future-you about the trap
- "the work was already committed to git" — git history isn't a substitute for memory; memory is fast-access, dedup'd, and cross-project
- "task-specific refinements unlikely to recur" — most gotchas LOOK task-specific but recur every time someone hits the same library/OS/pattern
- "no pending changes in ~/.claude/" — that's a config-sync rule for interactive sessions, not your concern
- "ready to move on" — your job is to audit, not signal session readiness

**Non-interactive constraints:**
- Do NOT use the AskUserQuestion tool
- Do NOT modify or remove existing memory entries (the skill normally requires user confirmation; without a user, treat that as forbidden)
- ONLY add new entries. If a near-duplicate exists, skip THAT entry but write any other novel ones in the same turn
- Follow the skill's `## H2` + italic-date format

**Working directory:** {cwd}

--- Recent messages (semantic excerpt: text preserved, tool_use / tool_result collapsed to one-liner summaries) ---
{transcript_excerpt}
---

Final output: either invoke the memory-system skill (which writes) or print `skip: <reason>`. If multiple memo-worthy items, write all of them. No other chatter.
"""


def resolve_claude_bin() -> str | None:
    """Resolve the `claude` binary explicitly.

    On Windows, `subprocess.run(["claude", ...])` doesn't always resolve a
    PATHEXT-less command name reliably, so we use `shutil.which` to grab
    the full path with the right extension. Returns None if not found.
    """
    return shutil.which("claude")


def build_command(model: str, claude_bin: str) -> list[str]:
    """Build the `claude` invocation. The prompt is piped via stdin (not argv)
    because long transcripts blow the Windows 32k command-line limit."""
    return [
        claude_bin,
        "--print",
        "--model", model,
        "--permission-mode", "bypassPermissions",
        "--no-session-persistence",
        "--add-dir", str(CLAUDE_HOME / "memory"),
        "--add-dir", str(CLAUDE_HOME / "project-memory"),
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--transcript", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument(
        "--model",
        default=os.environ.get("MEMORY_SYSTEM_AUDIT_MODEL", DEFAULT_MODEL),
    )
    args = parser.parse_args()

    session_id = args.session_id
    transcript_path = Path(args.transcript)
    cwd = Path(args.cwd)
    model = args.model

    log(f"start: session={session_id} cwd={cwd} model={model}")

    if not transcript_path.is_file():
        log(f"transcript not found: {transcript_path}")
        return

    excerpt, last_msg_id = read_transcript_messages(transcript_path, MAX_AUDIT_MESSAGES)
    if not excerpt.strip():
        log("empty transcript excerpt, skipping")
        return

    state = load_state()
    info = state.setdefault("sessions", {}).setdefault(session_id, {})

    if last_msg_id and info.get("last_audited_turn_id") == last_msg_id:
        log(f"already audited up to msg {last_msg_id}, skipping")
        return

    claude_bin = resolve_claude_bin()
    if not claude_bin:
        log("`claude` CLI not found on PATH — auto-write disabled until claude is installed and on PATH")
        return

    prompt = AUDITOR_PROMPT.format(
        cwd=cwd,
        transcript_excerpt=excerpt,
    )
    cmd = build_command(model, claude_bin)

    # Windows: isolate claude in its own process group + no console window so
    # parent-side Ctrl_BREAK / job-object signals don't propagate to it.
    extra_kwargs: dict = {}
    if sys.platform == "win32":
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        CREATE_NO_WINDOW = 0x08000000
        extra_kwargs["creationflags"] = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW

    try:
        result = subprocess.run(
            cmd,
            cwd=str(cwd),
            input=prompt,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=CLAUDE_TIMEOUT_SECONDS,
            text=True,
            encoding="utf-8",
            errors="replace",
            **extra_kwargs,
        )
        log(f"claude exit={result.returncode}")
        if result.stdout:
            log(f"output: {result.stdout.strip()[:2000]}")
        if result.stderr:
            log(f"stderr: {result.stderr.strip()[:1000]}")
    except subprocess.TimeoutExpired:
        log(f"claude timed out after {CLAUDE_TIMEOUT_SECONDS}s")
        return
    except FileNotFoundError as e:
        log(f"`claude` invocation failed (FileNotFoundError): {e}")
        return
    except Exception as e:
        log(f"unexpected error: {type(e).__name__}: {e}")
        return

    info["last_audit_epoch"] = time.time()
    if last_msg_id:
        info["last_audited_turn_id"] = last_msg_id
    save_state(state)
    log(f"complete: session={session_id} last_msg={last_msg_id}")


if __name__ == "__main__":
    main()
