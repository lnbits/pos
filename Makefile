PYTHON ?= python3
.PHONY: check test build package test-host test-contract test-ui
check:
	node --check src/domain.js
	node --check src/onchain.js
	node --check src/pos.js
	node --check src/index.js
	node --check ui/bridge.js
	node --check ui/keypad.js
	node --check ui/receipt.js
	node --check scripts/build.mjs
	node --check scripts/package.mjs
	node --test test/*.test.mjs

test: check

build:
	npm run build

package: check build
	node scripts/package.mjs

test-host:
	$(PYTHON) test/check_host.py

test-contract:
	$(PYTHON) test/check_host.py --contracts-only

test-ui:
	node test/check_ui.mjs
