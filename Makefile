SHELL := /bin/bash
BUN := bun

.PHONY: install up down migrate seed embed test lint verify-m0 verify-m1 verify-m2 verify-m3 verify-m4 verify-m5 verify-m6 verify-m7 verify-m8 verify restore-drill eval-search eval-search-live

# Scratch DB for MinimeBench — a throwaway database the runner DROPs and rebuilds. Derived
# from DATABASE_URL so non-default ports just work; override EVAL_DATABASE_URL to change it.
EVAL_DATABASE_URL ?= postgres://minime:minime@localhost:5432/minime_eval

# One-command setup for fresh machines (see AGENTS.md). Safe to re-run.
install:
	@bash scripts/install.sh

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

verify: verify-m0 verify-m1 verify-m2 verify-m3 verify-m4 verify-m5 verify-m6 verify-m7 verify-m8

# Restores the latest restic snapshot into a scratch DB and runs the m1 suite against it.
restore-drill:
	@./scripts/restore-drill.sh

# MinimeBench (offline, CI-safe): deterministic mock embeddings, single run, full area table.
# DATABASE_URL is pinned to the scratch DB at PROCESS START — the pool binds at module load,
# so an in-process swap is too late (incident 2026-06-12: the runner reset the real DB).
eval-search:
	@createdb $(notdir $(EVAL_DATABASE_URL)) 2>/dev/null || true
	@MINIME_MOCK_OLLAMA=1 DATABASE_URL=$(EVAL_DATABASE_URL) EVAL_DATABASE_URL=$(EVAL_DATABASE_URL) \
		$(BUN) run scripts/eval-search.ts --mode mock --round mock

# MinimeBench (live): configured embed provider, N=3 min/median/max. Needs a provider + DB.
eval-search-live:
	@createdb $(notdir $(EVAL_DATABASE_URL)) 2>/dev/null || true
	@DATABASE_URL=$(EVAL_DATABASE_URL) EVAL_DATABASE_URL=$(EVAL_DATABASE_URL) \
		$(BUN) run scripts/eval-search.ts --mode live --round live-r1 --repeats 3
