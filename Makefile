SHELL := /bin/bash
BUN := bun

.PHONY: install up down migrate seed embed test lint verify-m0 verify-m1 verify-m2 verify-m3 verify-m4 verify-m5 verify-m6 verify restore-drill

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

verify: verify-m0 verify-m1 verify-m2 verify-m3 verify-m4 verify-m5 verify-m6

# Restores the latest restic snapshot into a scratch DB and runs the m1 suite against it.
restore-drill:
	@./scripts/restore-drill.sh
