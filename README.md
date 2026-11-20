# PoS for LNbits WASM

A fresh point-of-sale extension, based on the features of [TPoS](https://github.com/lnbits/tpos) that current core exposes to WASM. Extension ID: `pos`. No TPoS database or Watchonly dependency.

**Development status:** the WASM component and browser assets build successfully. Source tests and compiled-component checks pass against the core commit below. Manual visual checks remain pending because the browser-control tool failed before navigation. Treat this as a development release.

The core reference is `lnbits/lnbits` dev commit `df3a180a438cad8bddb7fed68b6390bc27bae729` (version 1.7.1). TPoS behavior was reviewed at `80e0290fc3939d936674ded918407c5feb056727`. A version number alone does not guarantee that an older core build has these WASM APIs.

## Included features

- Owner-managed terminals, separate staff and customer-display links, link replacement and disabling.
- Product catalog, categories, search, product availability, optional price adjustment, product JSON import and small embedded images.
- Product carts and a numeric keypad; quantities, item notes and sale notes; held carts on the device.
- Satoshi or fiat prices, default/product taxes, inclusive/exclusive taxes, tips, custom tips and rounding up.
- Lightning invoices and configured core hosted fiat checkout; QR codes and payment status.
- Receipts and order slips through core's print dialog; business name, address and tax ID.
- Recent terminal sales, paged owner sales, CSV exports of the visible page, and owner payment refresh.
- Separate Lightning tip wallets and Lightning-address revenue shares, subject to core background-payment grants.
- A separate customer display with websocket refresh hints and polling; mobile layout and core dark-mode updates.

Excluded from this port: on-chain payments, Watchonly, cash recording, NFC/card-reader hardware, ATM/password flows, Inventory/Orders/Tabs integrations, remote image downloads and PWA installation. These need capabilities beyond the supported flow used here. Hosted fiat tips stay in the fiat receiving wallet.

## Access and payment rules

Core owns authentication. The iframe has no wallet keys or direct network access. Private storage is scoped to the invocation owner. Settings accept only wallets returned for that owner. There are no APIs for choosing a different owner.

A staff link is a secret capability: its holder can create invoices and read that terminal's recent receipts. A separate display link can only read the latest checkout. Public calls first resolve the owner from the saved link, then verify its role, revocation state and terminal. Wallet IDs, payout destinations and other terminals' data are omitted from public responses. Replace links to revoke shared access.

The server calculates prices, tax and tips. A checkout stores its cart, wallet, provider, rate and payout destinations before requesting an invoice. Retrying the same action reuses that checkout; a changed cart is rejected. The browser saves the action before sending it so a page reload can resume it. An uncertain invoice creation is kept for review instead of automatically creating another invoice. A verified paid event can recover a lost invoice response.

Only core's bound invoice status or a rechecked paid event can mark a sale paid. Browser messages and websocket messages are never payment proof. Owner refresh can ask core to refresh a pending payment in the saved wallet. It does not send payouts using authenticated spending permissions.

Automatic tips and revenue shares require an explicit core background-payment grant for the receiving wallet. Core controls its amount and destination limits. Each payout attempt is saved before sending. `pending` or `review` payouts are never automatically retried: inspect the wallet payment before taking any manual action. Fees can prevent a payout when the receiving wallet has insufficient spare funds. Use an owned, spendable Lightning wallet for splits.

All exports use core's per-owner `sync` lock. This lock is process-local: run one LNbits worker for this extension. Multiple workers sharing the same database are not supported for checkout/payout serialization.

## Limits

- 50 terminals per owner; 100 products per terminal; catalog settings up to 48 KB.
- 100 lines per cart; quantity 1–999; maximum Lightning charge 1 billion sats.
- One new checkout per terminal every two seconds; at most 100 open checkouts. Refresh pending sales from the owner screen when necessary.
- Six held carts, subject to core's device-storage quota. Held carts are not paid receipts. Core storage can expire or be cleared.
- Checkout recovery is per browser tab and staff link. Starting a separate sale is an explicit cashier choice; an earlier invoice may still be payable.
- PNG/JPEG/WebP data images only, at most 8 KB each and within the total catalog limit. External images are rejected.
- Historical reports retain their sale-time settings. CSV export covers the displayed page of 50 sales.

## Development and checks

Work in `<LNbits data folder>/wasm_extensions/pos`. All business logic is in `src/`; `ui/` contains the sandbox UI; `storage/` contains the new schema and JSON migration; `wasm/lnbits-extension.wit` declares the existing host imports. No core changes are required.

Dependencies are pinned in `package.json` and `package-lock.json`: Vue, QRCode, esbuild, Vue's SFC compiler, Jco and ComponentizeJS. The build precompiles Vue templates, bundles local assets and compiles the JavaScript guest into a WASM component. It does not need runtime template evaluation or a CDN. Use Node.js 24.

With a recent Node.js installed, source tests need no npm dependencies:

```sh
make check
```

Use the Python environment of the exact core checkout to test the real storage and wallet host contracts. The helper uses temporary, empty databases and mocked payments; it does not access live wallets:

```sh
LNBITS_CORE_PATH=/path/to/lnbits make test-contract PYTHON=/path/to/lnbits/.venv/bin/python
```

To build from the lockfile:

```sh
npm ci
make build
LNBITS_CORE_PATH=/path/to/lnbits make test-host PYTHON=/path/to/lnbits/.venv/bin/python
make package
```

`test-host` executes the compiled component against core's actual host imports. It also checks core's query-parameter conversion for payment status. `package` creates `dist/pos-0.1.0.zip` with only the runtime files. Core must install this release ZIP, not a GitHub source ZIP: source includes a Python test helper, which is deliberately excluded from the WASM release. Restart the development server after rebuilding so core warms the new component before serving requests.

Verified: `make check` (30 tests), `make build`, `make test-contract` and `make test-host`; HTTP checks through core for private settings, anonymous checkout, retry reuse, customer-display data and paid status. No real-money payments were used. The production dependency audit is clean; the full audit reports a moderate minimatch issue in Jco's development-only dependency chain.

Before production use, finish a manual browser check through the real core wrapper, including desktop/mobile checkout, display updates and print/CSV/payment-permission dialogs. Hosted fiat and external revenue payouts have not been exercised with live providers.

## License

MIT. TPoS is the feature reference; this is a separate WASM extension with fresh storage.
