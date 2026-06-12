SHELL := /bin/bash
BUN := bun

.PHONY: install setup install-hooks up down migrate seed embed test lint verify-m0 verify-m1 verify-m2 verify-m3 verify-m4 verify-m5 verify-m6 verify-m7 verify-m8 verify-m9 verify restore-drill restore-pitr promote-restore eval-search eval-search-live eval-snapshot eval-pmb

# Scratch DB for MinimeBench — a throwaway database the runner DROPs and rebuilds. Derived
# from DATABASE_URL so non-default ports just work; override EVAL_DATABASE_URL to change it.
EVAL_DATABASE_URL ?= postgres://minime:minime@localhost:5432/minime_eval

# One-command setup for fresh machines (see AGENTS.md). Safe to re-run.
install:
	@bash scripts/install.sh

# Interactive credentials + backup-storage wizard (writes .env). Optional — the
# local-Ollama defaults need no credentials; install.sh stays non-interactive.
setup:
	@bash scripts/setup-env.sh

# Owner-run, confirmation-gated: SessionEnd hook so every Claude Code session drops an
# episodic summary into the inbox (agents/hooks/session-capture.sh). Safe to re-run.
install-hooks:
	@bash scripts/install-session-hook.sh

# Start Postgres (Docker if present, else native service) and check Ollama models.
up:
	@./scripts/up.sh

down:
	@./scripts/down.sh

migrate:
	@$(BUN) run src/cli.ts migrate

seed:
	@$(BUN) run src/cli.ts seed

embed:
	@$(BUN) run src/cli.ts embed

test:
	@$(BUN) test

lint:
	@bunx biome check --write .

verify-m0:
	@$(BUN) run src/verify/m0.ts

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

# The full gate: every milestone suite PLUS the retrieval-regression gate (offline
# MinimeBench vs the committed baseline floors) — new features must not quietly make
# retrieval worse (gbrain-evals stability discipline, DECISIONS.md 2026-06-12).
verify: verify-m0 verify-m1 verify-m2 verify-m3 verify-m4 verify-m5 verify-m6 verify-m7 verify-m8 verify-m9 eval-search

# Restores the latest restic snapshot into a scratch DB and runs the m1 suite against it.
restore-drill:
	@./scripts/restore-drill.sh

# Point-in-time restore into the scratch minime_restore DB (live untouched). Picks the latest
# db-snap/dream snapshot at or before TIME. Usage: make restore-pitr TIME="2026-06-12 14:30"
restore-pitr:
	@test -n "$(TIME)" || { echo 'usage: make restore-pitr TIME="2026-06-12 14:30"'; exit 2; }
	@TIME="$(TIME)" ./scripts/restore-pitr.sh

# Promote minime_restore in as the live minime DB (atomic rename; refuses if live is in use,
# dumps a pre-promote safety snapshot first). Run restore-pitr first. Undo = rename back.
promote-restore:
	@./scripts/promote-restore.sh

# MinimeBench (offline, CI-safe): deterministic mock embeddings, single run, full area table.
# DATABASE_URL is pinned to the scratch DB at PROCESS START — the pool binds at module load,
# so an in-process swap is too late (incident 2026-06-12: the runner reset the real DB).
eval-search:
	@createdb $(notdir $(EVAL_DATABASE_URL)) 2>/dev/null || true
	@MINIME_MOCK_OLLAMA=1 DATABASE_URL=$(EVAL_DATABASE_URL) EVAL_DATABASE_URL=$(EVAL_DATABASE_URL) \
		$(BUN) run scripts/eval-search.ts --mode mock --round mock

# LongMemEval-s (public, 500 questions): one-off ~49M-token ingest, then judge-free
# session-level recall. Same scratch-DB safety contract as MinimeBench.
EVAL_LME_DATABASE_URL ?= postgres://minime:minime@localhost:5432/minime_eval_lme1
eval-longmemeval:
	@createdb $(notdir $(EVAL_LME_DATABASE_URL)) 2>/dev/null || true
	@DATABASE_URL=$(EVAL_LME_DATABASE_URL) EVAL_LME_DATABASE_URL=$(EVAL_LME_DATABASE_URL) \
		$(BUN) run scripts/eval-longmemeval.ts --phase all $(if $(ROUND),--round $(ROUND),)

# PrecisionMemBench (public, 89 cases, judge-free): retrieval-PRECISION benchmark.
# In-process runner — reads the harness clone's fixtures as data, executes none of its
# code, ports its scorer verbatim. Needs PMB_DIR (the clone), a live embed provider, and
# ideally the reranker (autocut is the experiment). ROUND labels the scorecard.
EVAL_PMB_DATABASE_URL ?= postgres://minime:minime@localhost:5432/minime_eval_pmb
ROUND ?= r1
eval-pmb:
	@createdb -O minime $(notdir $(EVAL_PMB_DATABASE_URL)) 2>/dev/null || true
	@psql -d $(notdir $(EVAL_PMB_DATABASE_URL)) \
		-c "create extension if not exists vector; create extension if not exists pgcrypto;" >/dev/null
	@DATABASE_URL=$(EVAL_PMB_DATABASE_URL) EVAL_PMB_DATABASE_URL=$(EVAL_PMB_DATABASE_URL) \
		$(BUN) run scripts/eval-precisionmembench.ts --out /tmp/minime-pmb
	@$(BUN) run scripts/eval-pmb-report.ts /tmp/minime-pmb --round $(ROUND)

# Official-harness variant for leaderboard submission: runs the third-party ava harness
# (external code — run this yourself) against scripts/pmb-server.ts over HTTP.
eval-pmb-official:
	@./scripts/eval-pmb.sh

# SkillEval: behavioral contracts of agents/skills/*.md, driven by a real model
# (CLASSIFY_PROVIDER/CLASSIFY_MODEL) through the audited tool door; judge-free scoring
# from the events log. Runs on the standing config (Bedrock LLM + OpenRouter embed);
# local Ollama is only the free fallback for harness smoke tests.
EVAL_SKILLS_DATABASE_URL ?= postgres://minime:minime@localhost:5432/minime_eval_skills

# SkillOpt: gbrain-style optimizer loop. Trains on fixtures/skill-tasks/train/, gated by
# contamination check + train-improves + held-out-no-regression. Candidates go to
# agents/skills/candidates/ for review. Usage: make optimize-skill SUITE=query
# [START_FROM=fixtures/skill-tasks/deficient-query.md] for the loop-validation run.
optimize-skill:
	@test -n "$(SUITE)" || { echo "usage: make optimize-skill SUITE=<suite> [START_FROM=...]"; exit 2; }
	@createdb -O minime $(notdir $(EVAL_SKILLS_DATABASE_URL)) 2>/dev/null || true
	@psql -d $(notdir $(EVAL_SKILLS_DATABASE_URL)) \
		-c "create extension if not exists vector; create extension if not exists pgcrypto;" >/dev/null
	@DATABASE_URL=$(EVAL_SKILLS_DATABASE_URL) EVAL_SKILLS_DATABASE_URL=$(EVAL_SKILLS_DATABASE_URL) \
		$(BUN) run scripts/optimize-skill.ts --suite $(SUITE) --round $(or $(ROUND),r1) \
		$(if $(START_FROM),--start-from $(START_FROM),)

eval-skills:
	@createdb -O minime $(notdir $(EVAL_SKILLS_DATABASE_URL)) 2>/dev/null || true
	@psql -d $(notdir $(EVAL_SKILLS_DATABASE_URL)) \
		-c "create extension if not exists vector; create extension if not exists pgcrypto;" >/dev/null
	@DATABASE_URL=$(EVAL_SKILLS_DATABASE_URL) EVAL_SKILLS_DATABASE_URL=$(EVAL_SKILLS_DATABASE_URL) \
		$(BUN) run scripts/eval-skills.ts --round $(ROUND)

# Release snapshot: dated, committed scorecard for the stability streak. Usage:
#   make eval-snapshot ROUND=v0.9   → docs/benchmarks/<date>-release-v0.9-minimebench.md
eval-snapshot:
	@test -n "$(ROUND)" || { echo "usage: make eval-snapshot ROUND=<release-tag>"; exit 2; }
	@createdb $(notdir $(EVAL_DATABASE_URL)) 2>/dev/null || true
	@MINIME_MOCK_OLLAMA=1 DATABASE_URL=$(EVAL_DATABASE_URL) EVAL_DATABASE_URL=$(EVAL_DATABASE_URL) \
		$(BUN) run scripts/eval-search.ts --mode mock --round release-$(ROUND)

# MinimeBench (live): configured embed provider, N=3 min/median/max. Needs a provider + DB.
eval-search-live:
	@createdb $(notdir $(EVAL_DATABASE_URL)) 2>/dev/null || true
	@DATABASE_URL=$(EVAL_DATABASE_URL) EVAL_DATABASE_URL=$(EVAL_DATABASE_URL) \
		$(BUN) run scripts/eval-search.ts --mode live --round $(or $(ROUND),live-r1) --repeats 3
