# Minime — agent install & operations contract

Minime is a local-first personal life database with MCP agent access. All data stays on this
machine (localhost Postgres + localhost Ollama only); anything an agent reads transits that
agent's model provider — tiered access minimizes and audits that surface.

## Install (one command, non-interactive)

```
git clone https://github.com/HengL2022/Minime minime && cd minime && bash scripts/install.sh
```

- **Safe to re-run** after any failure — every step detects before acting.
- Never prompts. On Linux, package installs need root or passwordless sudo
  (exit 4 tells you exactly what to do otherwise). macOS needs Homebrew or Docker.
- Disk: ~6 GB with the local models, ~300 MB without (`--no-ollama`).
- `make install` is an alias.

### Flags & knobs

| Flag | Effect |
|---|---|
| `--with-demo` | Load the fictional demo dataset (off by default — this is a personal database) |
| `--no-ollama` | Skip the LLM stack → degraded mode (see below) |
| `--skip-verify` | Skip the post-install verification suite |
| `--native` | Use native Postgres even when Docker is available |
| `--dry-run` | Print what would happen; only read-only detection runs |

| Env var | Default | Meaning |
|---|---|---|
| `MINIME_PG_PORT` | 5432 | Host port for Postgres (use when 5432 is taken) |
| `MINIME_PULL_TIMEOUT` | 2400 | Seconds before a model pull degrades instead of blocking |
| `MINIME_PULL_MODELS` | both models | Override which Ollama models to pull |
| `OLLAMA_URL` | http://localhost:11434 | Existing Ollama server to use |

## Reading the output

One line per step: `[N/9] OK|SKIP|WARN|FAIL <step>: <detail>`. On failure the **last two
lines** are always `ERROR: <sentence>` and `FIX: <copy-pasteable command>`.

Exit codes: `0` installed (parse `status:` below), `2` bad flag, `3` unsupported OS,
`4` root needed, `10` bun, `11` deps, `20–24` postgres, `40` env, `50` migrate,
`60` seed, `70` verify.

Final block is machine-parsable — **parse `status:` from it**:

```
==== MINIME INSTALL SUMMARY ====
status: ok | degraded
postgres: docker pg16 @ 127.0.0.1:5432
ollama: ok (nomic-embed-text,llama3.1:8b)
demo: seeded | not requested
verify: pass | pass-degraded | skipped
mcp: .mcp.json (in-repo) — see AGENTS.md to register elsewhere
next: bun run src/cli.ts serve
================================
```

## Degraded mode (status: degraded)

Everything works without Ollama except two features:

| Missing | Effect | Recover |
|---|---|---|
| Embedding model | Search falls back to full-text only (no semantic matches) | `ollama pull nomic-embed-text && make embed` |
| Classify model | Inbox captures queue for manual review instead of auto-filing | `ollama pull llama3.1:8b` |
| Docker | Native Postgres instead: PG16 via PGDG on Linux, PG17 via Homebrew on macOS | nothing to do |

## Register the MCP server

The server is stdio: `bun run <ABS_REPO_PATH>/src/cli.ts serve` (also starts the inbox
watcher + nightly maintenance cron). Use **absolute paths** outside the repo.

- **Claude Code, inside the repo**: `.mcp.json` is auto-discovered — just start Claude Code
  in this directory.
- **Claude Code, global**: `claude mcp add minime -- bun run <ABS_REPO_PATH>/src/cli.ts serve`
- **Any other MCP harness** (Hermes/OpenClaw/Cursor-style):
  ```json
  { "command": "bun", "args": ["run", "<ABS_REPO_PATH>/src/cli.ts", "serve"] }
  ```

11 tools: `minime_search`, `minime_get_context`, `minime_state`, `minime_query_metric`,
`minime_capture`, `minime_journal`, `minime_log_decision`, `minime_review_decision`,
`minime_upsert_task`, `minime_log_interaction`, `minime_unlock`. Numbers come only from
`minime_query_metric`; tier-2 reads (journal, interactions, email metadata) need
`minime_unlock`; tier-0 (transactions, health) is never readable — aggregates only.

## After install

```
bun run src/cli.ts serve            # resident: MCP + watcher + 3am dream job
make verify                         # all milestone acceptance gates (m0–m6)
bun run src/cli.ts audit --since 7d # what left the box, to which client
bun run src/cli.ts import:calendar export.ics       # and the other importers
```

Agent workflow prompts (morning brief, evening review, decision brief) live in
`agents/skills/*.md`. Project conventions for agents *working on the code* are in
`CLAUDE.md`; the spec is `minime-build-plan.md`.

## Uninstall / reset

- Stop: `make down` (Docker) or `brew services stop postgresql@17` / `systemctl stop postgresql@16-main`.
- **Destructive**: `docker compose down -v` deletes the database volume. Your captured
  files stay in `data/` either way — that directory is the archive; treat it like one.
