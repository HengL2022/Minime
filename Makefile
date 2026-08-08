SHELL := /bin/bash
BUN := bun

# Freeze command-line BASE literally before exporting it to the recipe shell. This keeps
# Make functions such as $(shell ...) and $(file ...) data in the ref, never Make actions.
ifneq ($(origin BASE),undefined)
override BASE_LITERAL := $(value BASE)
override BASE := $(BASE_LITERAL)
export BASE
endif

# Keep restore selection opaque until the recipe shell expands the exported value as one quoted
# argv element. In particular, Make functions in command-line TIME are data, never Make actions.
ifneq ($(origin TIME),undefined)
override TIME_LITERAL := $(value TIME)
override TIME := $(TIME_LITERAL)
export TIME
endif

.PHONY: install setup install-hooks install-service uninstall-service onboard update up down psql-ro migrate provision-runtime-role seed embed test lint format typecheck typecheck-ops verify-m0 verify-m0-offline verify-m1 verify-m2 verify-m3 verify-m4 verify-m5 verify-m6 verify-m7 verify-m8 verify-m9 verify-m10 verify-m11 verify-m12 verify-m13 verify-m14 verify-m15 check-subsystems check-tracked-privacy verify-offline verify verify-restore-e2e restore-drill restore-pitr promote-restore eval-search eval-search-live eval-snapshot eval-pmb eval-pmb-official eval-graph-hygiene eval-skills optimize-skill

# Every automated child is provisioned by this parent-owned runner. The child receives only
# the generated loopback URL and (where applicable) one approved compatibility alias.
TEST_DB_RUNNER := $(BUN) run scripts/with-test-database.ts

# One-command setup for fresh machines (see AGENTS.md). Safe to re-run.
install:
	@bash scripts/install.sh

# Interactive credentials + backup-storage wizard (writes .env). Optional — the
# local-Ollama defaults need no credentials; install.sh stays non-interactive.
setup:
	@bash scripts/setup-env.sh

# First-run interview: seeds values, goals, principles, key people, projects, and an
# opening journal entry. Optional, skippable per question, re-run adds (never overwrites).
onboard:
	@$(BUN) run src/cli.ts onboard

# Pull the latest version from GitHub and migrate — never touches .env*, data/, or
# backups (gitignored). Takes a restic db-snap first when backups are configured.
update:
	@bash scripts/update.sh

# Owner-run, confirmation-gated: SessionEnd hook so every Claude Code session drops an
# episodic summary into the inbox (agents/hooks/session-capture.sh). Safe to re-run.
install-hooks:
	@bash scripts/install-session-hook.sh

# Owner-run: install the resident `serve` as a per-user background service -- a launchd
# LaunchAgent on macOS, a systemd --user unit on Linux (docs/GUIDE.md "Keeping Minime
# running"). Renders ops/service/*.tmpl and (re)starts it; safe to re-run. DRY_RUN=1 prints
# the rendered file without touching launchd/systemd. FORCE_OS=macos|debian reviews the
# other branch from either OS. It is just another `serve`; the W3-5 lock decides ownership.
install-service:
	@bash scripts/install-service.sh install

# Stop and remove the installed LaunchAgent/systemd unit. Safe to re-run even if absent.
uninstall-service:
	@bash scripts/install-service.sh uninstall

# Start Postgres (Docker if present, else native service) and check Ollama models.
up:
	@./scripts/up.sh

down:
	@./scripts/down.sh

# Read-only psql for engineering sessions (W4): SELECT-only role, RLS tier-gated.
psql-ro:
	@psql "$$(grep '^DATABASE_URL=' .env.engineering | cut -d= -f2-)"

migrate:
	@$(BUN) run src/cli.ts migrate --context direct

# Existing installs: provision the restricted role and publish its DSN in .env. The owner DSN
# remains DATABASE_URL for migrations; the resident app cuts over on the generated endpoint.
provision-runtime-role:
	@set -eu; \
	owner_url="$$(sed -n 's/^DATABASE_URL=//p' .env | tail -n 1)"; \
	if [ -n "$${DATABASE_URL:-}" ] && [ "$$DATABASE_URL" != "$$owner_url" ]; then echo 'runtime_role_configuration_invalid' >&2; exit 2; fi; \
	app_password="$$(sed -n 's/^MINIME_APP_PASSWORD=//p' .env | tail -n 1)"; \
	test -n "$$owner_url" || { echo 'runtime_role_configuration_invalid' >&2; exit 2; }; \
	DATABASE_URL="$$owner_url" $(BUN) --no-env-file -e 'import { parseLocalPostgresUrl } from "./src/util/postgres-url"; parseLocalPostgresUrl(process.env.DATABASE_URL, "minime")' >/dev/null 2>&1 || { echo 'runtime_role_configuration_invalid' >&2; exit 2; }; \
	DATABASE_URL="$$owner_url" MINIME_APP_DATABASE_URL="$$owner_url" $(BUN) run src/cli.ts migrate --context direct; \
	if [ -n "$$app_password" ] && ! [[ "$$app_password" =~ ^[A-Za-z0-9_-]{24,128}$$ ]]; then echo 'runtime_role_configuration_invalid' >&2; exit 2; fi; \
	if [ -z "$$app_password" ]; then \
		if command -v openssl >/dev/null 2>&1; then app_password="$$(openssl rand -hex 32)"; else app_password="$$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9_-' | cut -c1-64)"; fi; \
	fi; \
	[[ "$$app_password" =~ ^[A-Za-z0-9_-]{24,128}$$ ]] || { echo 'runtime_role_configuration_invalid' >&2; exit 2; }; \
	app_url="$$(DATABASE_URL="$$owner_url" MINIME_APP_PASSWORD="$$app_password" $(BUN) --no-env-file -e 'import { derivePostgresCredentials } from "./src/util/postgres-url"; console.log(derivePostgresCredentials(process.env.DATABASE_URL, "minime_app", process.env.MINIME_APP_PASSWORD, "minime"))')"; \
	DATABASE_URL="$$owner_url" MINIME_APP_DATABASE_URL="$$app_url" MINIME_APP_PASSWORD="$$app_password" $(BUN) run scripts/provision-runtime-role.ts; \
	chmod 600 .env; \
	tmp="$$(mktemp .env.runtime.XXXXXX)"; \
	MINIME_APP_PASSWORD="$$app_password" MINIME_APP_DATABASE_URL="$$app_url" awk 'BEGIN{seen_password=0;seen_url=0} /^MINIME_APP_PASSWORD=/{if(!seen_password){print "MINIME_APP_PASSWORD=" ENVIRON["MINIME_APP_PASSWORD"];seen_password=1};next} /^MINIME_APP_DATABASE_URL=/{if(!seen_url){print "MINIME_APP_DATABASE_URL=" ENVIRON["MINIME_APP_DATABASE_URL"];seen_url=1};next} {print} END{if(!seen_password) print "MINIME_APP_PASSWORD=" ENVIRON["MINIME_APP_PASSWORD"]; if(!seen_url) print "MINIME_APP_DATABASE_URL=" ENVIRON["MINIME_APP_DATABASE_URL"]}' .env > "$$tmp"; \
	chmod 600 "$$tmp"; \
	mv "$$tmp" .env

seed:
	@$(BUN) run src/cli.ts seed

embed:
	@$(BUN) run src/cli.ts embed

test:
	@$(BUN) test

lint:
	@$(BUN) run lint

format:
	@$(BUN) run format

typecheck:
	@$(BUN) run typecheck

typecheck-ops:
	@$(BUN) run typecheck:ops

verify-m0:
	@$(BUN) run src/verify/m0.ts

verify-m0-offline:
	@MINIME_MOCK_OLLAMA=1 $(TEST_DB_RUNNER) --label verify_m0 -- \
		$(BUN) run src/verify/m0.ts

verify-m1:
	@$(BUN) test test/m1.*.test.ts

verify-m2:
	@$(BUN) test test/m2.*.test.ts

verify-m3:
	@$(BUN) test test/m3.*.test.ts

verify-m4:
	@$(BUN) test test/m4.*.test.ts

verify-m5:
	@$(BUN) test test/m5.*.test.ts

verify-m6:
	@$(BUN) test test/m6.*.test.ts

verify-m7:
	@$(BUN) test test/m7.*.test.ts

verify-m8:
	@$(BUN) test test/m8.*.test.ts

verify-m9:
	@$(BUN) test test/m9.*.test.ts

verify-m10:
	@$(BUN) test test/m10.*.test.ts

verify-m11:
	@$(BUN) test test/m11.*.test.ts

verify-m12:
	@$(BUN) test test/m12.*.test.ts

# W3: per-tier classify routing (PROVIDER_ROUTE_TIER1/2 over the CLOUD_MAX_TIER ceiling).
verify-m13:
	@$(BUN) test test/m13.*.test.ts

# W1: nightly extractor re-validation (dream 3c_validate_edges) — planted-corpus bar: 100%
# of 3 planted-bad edges flagged, 0 false flags on the 2 planted-good edges (mock verdicts;
# the live-model bake is make eval-graph-hygiene, owner-run).
verify-m14:
	@$(BUN) test test/m14.*.test.ts

# W4: engineer read-only role (minime_engineer_ro) + committed-script repair runner.
verify-m15:
	@$(BUN) test test/m15.*.test.ts

# W2 complexity-budget gate: docs/SUBSYSTEMS.md ↔ src/ structural coverage (both
# directions), pure filesystem — no git, no network (scripts/check-subsystems.ts).
check-subsystems:
	@$(BUN) run scripts/check-subsystems.ts

# Offline tracked-tree/outgoing-range privacy scan. Terms are supplied only through stdin.
check-tracked-privacy:
	@$(BUN) run scripts/check-tracked-privacy.ts --base "$${BASE}"

verify-offline:
	@bash scripts/verify-offline.sh

# Release/search gate: the complete offline verification gate plus retrieval-regression
# evaluation against committed baseline floors. Do not run both targets separately.
verify: verify-offline eval-search

# Restore the latest real restic snapshot into minime_drill, verify its manifest/counts, migrate
# the scratch schema to the checked-out ledger, validate safety posture, and remove the scratch DB.
restore-drill:
	@$(BUN) --no-env-file run scripts/recovery-ops.ts drill

# Self-contained release evidence: a fictional snapshot round trip in a private temporary
# PostgreSQL cluster and local restic repository. Never connects to the configured/live cluster.
verify-restore-e2e:
	@$(BUN) --no-env-file run scripts/verify-restic-roundtrip.ts

# Logical snapshot restore into scratch minime_restore (live untouched). The compatibility
# command name is restore-pitr; it picks the latest db-snap/dream snapshot at or before TIME.
# This is not WAL/PITR. Usage: make restore-pitr TIME="2026-06-12 14:30"
restore-pitr:
	@$(BUN) --no-env-file run scripts/recovery-ops.ts pitr "$${TIME}"

# Promote minime_restore through a guarded two-step rename. It refuses active sessions/prepared
# transactions, writes a safety dump first, blocks new connections, and compensates a failed
# second rename back to the original live name. Run restore-pitr and inspect its scratch first.
promote-restore:
	@$(BUN) --no-env-file run scripts/recovery-ops.ts promote

# MinimeBench (offline, CI-safe): deterministic mock embeddings, single run, full area table.
eval-search:
	@MINIME_MOCK_OLLAMA=1 $(BUN) run scripts/eval-search.ts --mode mock --round mock

# LongMemEval-s (public, 500 questions): one-off ~49M-token ingest, then judge-free
# session-level recall. Same scratch-DB safety contract as MinimeBench.
EVAL_LME_DATABASE_URL ?= postgres://minime:minime@localhost:5432/minime_eval_lme1
eval-longmemeval:
	@createdb $(notdir $(EVAL_LME_DATABASE_URL)) 2>/dev/null || true
	@DATABASE_URL=$(EVAL_LME_DATABASE_URL) MINIME_APP_DATABASE_URL=$(EVAL_LME_DATABASE_URL) EVAL_LME_DATABASE_URL=$(EVAL_LME_DATABASE_URL) \
		$(BUN) run scripts/eval-longmemeval.ts --phase all $(if $(ROUND),--round $(ROUND),)

# PrecisionMemBench (public, 89 cases, judge-free): retrieval-PRECISION benchmark.
# In-process runner — reads the harness clone's fixtures as data, executes none of its
# code, ports its scorer verbatim. Needs PMB_DIR (the clone), a live embed provider, and
# ideally the reranker (autocut is the experiment). ROUND labels the scorecard.
ROUND ?= r1
eval-pmb:
	@$(TEST_DB_RUNNER) --label eval_pmb --database-env EVAL_PMB_DATABASE_URL -- \
		$(BUN) run scripts/eval-precisionmembench.ts --out /tmp/minime-pmb
	@$(BUN) run scripts/eval-pmb-report.ts /tmp/minime-pmb --round $(ROUND)

# Official-harness variant for leaderboard submission: runs the third-party ava harness
# (external code — run this yourself) against scripts/pmb-server.ts over HTTP.
eval-pmb-official:
	@$(TEST_DB_RUNNER) --label eval_pmb_official --database-env EVAL_PMB_DATABASE_URL -- \
		./scripts/eval-pmb.sh

# SkillEval: behavioral contracts of agents/skills/*.md, driven by a real model
# (CLASSIFY_PROVIDER/CLASSIFY_MODEL) through the audited tool door; judge-free scoring
# from the events log. Runs on the standing config (Bedrock LLM + OpenRouter embed);
# local Ollama is only the free fallback for harness smoke tests.
# SkillOpt: gbrain-style optimizer loop. Trains on fixtures/skill-tasks/train/, gated by
# contamination check + train-improves + held-out-no-regression. Candidates go to
# agents/skills/candidates/ for review. Usage: make optimize-skill SUITE=query
# [START_FROM=fixtures/skill-tasks/deficient-query.md] for the loop-validation run.
optimize-skill:
	@test -n "$(SUITE)" || { echo "usage: make optimize-skill SUITE=<suite> [START_FROM=...]"; exit 2; }
	@$(TEST_DB_RUNNER) \
		--label eval_skill_optimize --database-env EVAL_SKILLS_DATABASE_URL -- \
		$(BUN) run scripts/optimize-skill.ts --suite $(SUITE) --round $(or $(ROUND),r1) $(if $(START_FROM),--start-from $(START_FROM),)

eval-skills:
	@$(TEST_DB_RUNNER) \
		--label eval_skills --database-env EVAL_SKILLS_DATABASE_URL -- \
		$(BUN) run scripts/eval-skills.ts --round $(ROUND)

# Release snapshot: dated, committed scorecard for the stability streak. Usage:
#   make eval-snapshot ROUND=v0.9   → docs/benchmarks/<date>-release-v0.9-minimebench.md
eval-snapshot:
	@test -n "$(ROUND)" || { echo "usage: make eval-snapshot ROUND=<release-tag>"; exit 2; }
	@MINIME_MOCK_OLLAMA=1 $(BUN) run scripts/eval-search.ts --mode mock --round release-$(ROUND) --publish-scorecard

# MinimeBench (live): configured embed provider, N=3 min/median/max. Needs a provider + DB.
eval-search-live:
	@$(BUN) run scripts/eval-search.ts --mode live --round $(or $(ROUND),live-r1) --repeats 3 --publish-scorecard

# W1 graph-hygiene live bake (owner-run; CI bar is the mock path inside verify-m14)
eval-graph-hygiene:
	@$(TEST_DB_RUNNER) --label eval_graph_hygiene --database-env EVAL_DATABASE_URL -- \
		$(BUN) run scripts/eval-graph-hygiene.ts
