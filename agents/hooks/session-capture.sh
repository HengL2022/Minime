#!/bin/bash
# Claude Code SessionEnd hook: episodic capture of agent work sessions (DECISIONS.md
# 2026-06-12, agentmemory-inspired). Heuristic extraction only — no model call, no network
# (I1); the summary is dropped as plain markdown into Minime's inbox, the same one-door
# path as any other capture (I2). The watcher classifies and files it; provenance is the
# inbox item like every capture (I5).
#
# stdin: hook JSON {session_id, transcript_path, cwd, reason}. Install via
# `make install-hooks` (bakes MINIME_DATA_DIR into the hook command); never auto-installed.
# macOS bash-3.2 clean. Exit 0 always — a capture failure must never disturb the session.

input=$(cat)
DATA_DIR="${MINIME_DATA_DIR:-$HOME/Minime/data}"

# the heredoc IS python's stdin (program source), so the hook JSON travels via env
HOOK_JSON="$input" python3 - "$DATA_DIR" <<'PYEOF' 2>/dev/null
import json, os, re, subprocess, sys

def text_of(content):
    # message content is either a plain string or a list of typed blocks
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text").strip()
    return ""

def clip(s, n):
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"

hook = json.loads(os.environ.get("HOOK_JSON", "{}"))
data_dir = sys.argv[1]
sid = str(hook.get("session_id", ""))
transcript = hook.get("transcript_path", "")
cwd = hook.get("cwd", "") or ""
if not sid or not transcript or not os.path.isfile(transcript):
    sys.exit(0)

id8 = sid[:8]
inbox = os.path.join(data_dir, "inbox")
archive = os.path.join(data_dir, "archive")
# idempotent per session: the watcher archives a copy but leaves the original, so one
# basename check over both trees covers re-fired hooks either way
for root in (inbox, archive):
    for dirpath, _dirs, files in os.walk(root):
        if any(f.startswith("session-") and id8 in f for f in files):
            sys.exit(0)

prompts, last_assistant, files, first_ts, last_ts = [], "", [], "", ""
with open(transcript, encoding="utf-8", errors="replace") as f:
    for line in f:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        ts = e.get("timestamp", "")
        if ts:
            first_ts = first_ts or ts
            last_ts = ts
        msg = e.get("message") or {}
        if e.get("type") == "user" and not e.get("isMeta"):
            t = text_of(msg.get("content"))
            if t and not t.startswith("<"):  # skip tool results / injected reminders
                prompts.append(t)
        elif e.get("type") == "assistant":
            t = text_of(msg.get("content"))
            if t:
                last_assistant = t
            for b in msg.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use" \
                        and b.get("name") in ("Write", "Edit", "NotebookEdit"):
                    p = (b.get("input") or {}).get("file_path")
                    if p and p not in files:
                        files.append(p)

if len(prompts) < 2:  # trivial session: not worth an inbox item
    sys.exit(0)

branch = ""
try:
    branch = subprocess.run(
        ["git", "-C", cwd, "branch", "--show-current"],
        capture_output=True, text=True, timeout=5).stdout.strip()
except Exception:
    pass

day = (first_ts or "")[:10]
span = " to ".join(t[11:16] for t in (first_ts, last_ts) if len(t) >= 16)
where = os.path.basename(cwd) or cwd
# heading first: the watcher's title heuristics read line 1, and the classifier hint
# comment works anywhere in the text
lines = [
    "# Agent session: %s%s%s" % (where, " (%s)" % branch if branch else "", " — %s" % day if day else ""),
    "<!-- hint: agent work session -->",
    "",
    "Worked in `%s`%s%s." % (cwd, " on branch `%s`" % branch if branch else "", ", %s" % span if span else ""),
    "",
    "**Request:** %s" % clip(prompts[0], 500),
    "",
    "**Outcome:** %s" % clip(last_assistant or "(no final summary)", 700),
]
if files:
    lines += ["", "**Files touched:**"] + ["- %s" % p for p in files[:20]]
    if len(files) > 20:
        lines.append("- … and %d more" % (len(files) - 20))

os.makedirs(inbox, exist_ok=True)
stamp = re.sub(r"[:.]", "-", (last_ts or first_ts or "")[:19]) or "unknown"
path = os.path.join(inbox, "session-%s-%s.md" % (stamp, id8))
with open(path, "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
PYEOF
exit 0
