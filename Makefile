.PHONY: help install dev start build build-release lint typecheck typecheck-strict \
        test test-unit test-vitest test-coverage test-all test-integration test-e2e \
        check check-cycles check-docs env-sync clean \
        serve stop restart status info logs autostart-enable autostart-disable build-cli

# OmniRoute — convenience wrapper around the npm scripts.
# All targets delegate to the canonical package.json scripts (single source of truth).
#
# `dev`/`start` above run in the foreground with no process management — for a
# persistent local background service, use the lifecycle targets below instead.
# Those wrap OmniRoute's own CLI (bin/omniroute.mjs), which already has real
# PID-file-based daemon management; this Makefile does not reimplement it.

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (auto-generates .env from .env.example)
	npm install

dev: ## Dev server at http://localhost:20128
	npm run dev

start: ## Production server (requires a prior build)
	npm run start

# Turbopack (the default bundler for `npm run build`) hung indefinitely on this
# machine — confirmed by direct process inspection: the entire build worker pool
# sat at 0% CPU with zero file writes for 27+ minutes, no error, no timeout, just
# silence. OMNIROUTE_USE_TURBOPACK=0 (the documented webpack fallback, see
# docs/reference/ENVIRONMENT.md) completed reliably in ~40 minutes. These targets
# default to the webpack fallback for that reason — slower, but it finishes.
# This only affects `make build`/`make build-release`/`make serve`; a bare
# `npm run build` still defaults to Turbopack, matching upstream.
build: ## Production build (Next.js 16 standalone; webpack — see note above)
	OMNIROUTE_USE_TURBOPACK=0 npm run build

build-release: ## Release build (webpack — see note above)
	OMNIROUTE_USE_TURBOPACK=0 npm run build:release

serve: ## Start OmniRoute in the background (packages dist/ first if missing)
	@test -f dist/server.js || $(MAKE) build-cli
	node bin/omniroute.mjs serve --daemon

build-cli: ## Assemble dist/ from the standalone build (npm run build:cli; builds first if needed)
	OMNIROUTE_USE_TURBOPACK=0 npm run build:cli

stop: ## Stop the background OmniRoute instance
	node bin/omniroute.mjs stop

# Deliberately NOT `node bin/omniroute.mjs restart`: that subcommand has no
# --daemon flag, so it restarts in foreground/supervisor mode instead — the
# process never returns, blocking whatever shell invoked `make restart` until
# manually interrupted (confirmed directly: it printed "Press Ctrl+C to stop"
# and sat there). stop + serve --daemon gets a real daemonized restart.
restart: ## Restart the background instance (rebuilds are NOT automatic — run `make build` first if source changed)
	node bin/omniroute.mjs stop
	node bin/omniroute.mjs serve --daemon

status: ## Live health check (DB, encryption, ports, runtime — the deep check)
	node bin/omniroute.mjs doctor

info: ## Non-live status: version, DATA_DIR, DB file, detected CLI tool integrations
	node bin/omniroute.mjs status

logs: ## Follow live logs (Ctrl+C to stop)
	node bin/omniroute.mjs logs --follow

autostart-enable: ## Register OmniRoute to start at login (launchd/systemd/XDG/Windows)
	node bin/omniroute.mjs autostart enable

autostart-disable: ## Remove OmniRoute from login startup
	node bin/omniroute.mjs autostart disable

lint: ## ESLint (0 errors expected)
	npm run lint

typecheck: ## TypeScript check (core)
	npm run typecheck:core

typecheck-strict: ## Strict check (no implicit any)
	npm run typecheck:noimplicit:core

test: ## Unit tests (Node native runner)
	npm run test:unit

test-unit: ## Alias for `test`
	npm run test:unit

test-vitest: ## Vitest (MCP server, autoCombo, cache)
	npm run test:vitest

test-coverage: ## Unit tests + coverage gate (60/60/60/60)
	npm run test:coverage

test-all: ## All suites (unit + vitest + ecosystem + e2e)
	npm run test:all

test-integration: ## Integration tests
	npm run test:integration

test-e2e: ## E2E (Playwright)
	npm run test:e2e

check: ## lint + test combined
	npm run check

check-cycles: ## Detect circular dependencies
	npm run check:cycles

check-docs: ## Validate documentation (incl. fabricated-docs)
	npm run check:docs-all

env-sync: ## Sync .env from .env.example
	npm run env:sync

clean: ## Remove build artifacts
	rm -rf .build dist coverage .eslintcache
