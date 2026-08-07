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
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P) || exit 0
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." 2>/dev/null && pwd -P) || exit 0
case "$DATA_DIR" in
  /*) ;;
  *) DATA_DIR="$REPO_DIR/$DATA_DIR" ;;
esac

# the heredoc IS python's stdin (program source), so the hook JSON travels via env
HOOK_JSON="$input" python3 - "$DATA_DIR" "$REPO_DIR" <<'PYEOF' 2>/dev/null
import json, os, re, secrets, stat, subprocess, sys, tempfile

def is_equal_or_ancestor(candidate, protected):
    try:
        return os.path.commonpath([candidate, protected]) == candidate
    except ValueError:
        return False

def filesystem_identity(path):
    try:
        info = os.stat(path)
        return (info.st_dev, info.st_ino)
    except OSError:
        return None

def existing_ancestors(path):
    current = os.path.abspath(path)
    found = []
    while True:
        if os.path.exists(current):
            found.append(current)
        parent = os.path.dirname(current)
        if parent == current:
            return found
        current = parent

def canonicalize_trusted_system_alias(path):
    candidate = os.path.abspath(path)
    for alias in ("/tmp", "/var"):
        if candidate != alias and not candidate.startswith(alias + os.sep):
            continue
        try:
            info = os.lstat(alias)
            if not stat.S_ISLNK(info.st_mode) or info.st_uid != 0:
                continue
            relative = os.path.relpath(candidate, alias)
            return os.path.abspath(os.path.join(os.path.realpath(alias), relative))
        except OSError:
            pass
    return candidate

def assert_dedicated_data_root(path, repo_root):
    root = os.path.abspath(path)
    protected = []
    for item in [os.sep, "/tmp", "/var/tmp", os.path.expanduser("~"), tempfile.gettempdir(), repo_root]:
        protected.extend([os.path.abspath(item), os.path.realpath(item)])
    if root != os.path.join(os.path.realpath(repo_root), "data"):
        protected.extend([os.path.abspath(os.getcwd()), os.path.realpath(os.getcwd())])
    protected_identities = {
        identity for item in protected for identity in [filesystem_identity(item)]
        if identity is not None
    }
    protected_identities.update(
        identity for item in protected for ancestor in existing_ancestors(item)
        for identity in [filesystem_identity(ancestor)] if identity is not None
    )
    if (any(is_equal_or_ancestor(root, item) for item in protected) or
            filesystem_identity(root) in protected_identities):
        raise OSError("unsafe private directory")

def assert_no_symlink_components(path):
    current = os.path.abspath(os.sep)
    components = [part for part in os.path.abspath(path).split(os.sep) if part]
    for component in components:
        current = os.path.join(current, component)
        if not os.path.lexists(current):
            break
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise OSError("unsafe private directory")

def assert_descendant(root, path):
    root = os.path.abspath(root)
    path = os.path.abspath(path)
    if path == root or not is_equal_or_ancestor(root, path):
        raise OSError("unsafe private directory")

def ensure_private_dir(path):
    path = os.path.abspath(path)
    assert_no_symlink_components(path)
    current = os.path.abspath(os.sep)
    for component in [part for part in path.split(os.sep) if part]:
        current = os.path.join(current, component)
        if os.path.lexists(current):
            info = os.lstat(current)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise OSError("unsafe private directory")
            continue
        os.mkdir(current, 0o700)
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise OSError("unsafe private directory")
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        if not stat.S_ISDIR(os.fstat(fd).st_mode):
            raise OSError("unsafe private directory")
        os.fchmod(fd, 0o700)
    finally:
        os.close(fd)
    if os.path.islink(path) or not os.path.isdir(path):
        raise OSError("unsafe private directory")

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
data_dir = canonicalize_trusted_system_alias(sys.argv[1])
repo_root = sys.argv[2]
sid = str(hook.get("session_id", ""))
transcript = hook.get("transcript_path", "")
cwd = hook.get("cwd", "") or ""
if not sid or not transcript or not os.path.isfile(transcript):
    sys.exit(0)

id8 = sid[:8]
inbox = os.path.join(data_dir, "inbox")
archive = os.path.join(data_dir, "archive")
assert_dedicated_data_root(data_dir, repo_root)
ensure_private_dir(data_dir)
assert_descendant(data_dir, inbox)
ensure_private_dir(inbox)
# idempotent per session: the watcher archives a copy but leaves the original, so one
# basename check over both trees covers re-fired hooks either way
for root in (inbox, archive):
    if os.path.lexists(root):
        if root != inbox:
            assert_descendant(data_dir, root)
        assert_no_symlink_components(root)
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

stamp = re.sub(r"[:.]", "-", (last_ts or first_ts or "")[:19]) or "unknown"
path = os.path.join(inbox, "session-%s-%s.md" % (stamp, id8))
temporary = os.path.join(inbox, ".session-%s-%s.tmp" % (os.getpid(), secrets.token_hex(8)))
try:
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        os.fchmod(f.fileno(), 0o600)
        f.write("\n".join(lines) + "\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(temporary, path)
    directory_fd = os.open(inbox, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
finally:
    try:
        os.unlink(temporary)
    except OSError:
        pass
PYEOF
exit 0
