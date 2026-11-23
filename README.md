# PoS for LNbits WASM

<img src="static/assets/icon.png" width="128" alt="PoS logo">

**Your Bitcoin counter.** A fresh point-of-sale extension, based on the features of [TPoS](https://github.com/lnbits/tpos) that current core exposes to WASM. Extension ID: `pos`. No TPoS database or Watchonly dependency.

**Development status:** the WASM component and browser assets build successfully. Source tests and compiled-component checks pass against the core commit below. Manual visual checks remain pending. Treat this as a development release.

The on-chain host calls are checked against local core commit `a8aee7649`, including real address allocation and owner isolation. Visual browser checks remain pending approval to open a disposable demo account.

The owner screen follows TPoS's terminal table, expandable Items table and settings sections. The cashier uses the same four-column keypad with implicit decimal entry, product grid/list, right-hand cart, options menu and tip flow. PoS keeps its own name and logo and uses core's theme. Only supported payment methods are shown.

PoS 0.3.0 requires core's `reserve_address_public` host API and extended wallet summaries, available at `lnbits/lnbits` commit `a8aee7649db24aaba93892652bfbbef8cb7a28c7` on `feat/wasm-onchain-checkouts`. Older core builds cannot load this component, even with on-chain payments disabled. TPoS behavior was reviewed at `80e0290fc3939d936674ded918407c5feb056727`. A version number alone does not guarantee that a core build has these WASM APIs.

## Included features

- Owner-managed terminals, separate staff and customer-display links, link replacement and disabling.
- Product catalog, categories, search, product availability, optional price adjustment, product JSON import and small embedded images.
- Product carts and a numeric keypad; quantities, item notes and sale notes; held carts on the device.
- Satoshi or fiat prices, default/product taxes, inclusive/exclusive taxes, tips, custom tips and rounding up.
- Lightning invoices and configured core hosted fiat checkout; QR codes and payment status.
- Core on-chain wallets, fresh checkout addresses, Bitcoin QR codes, received amounts and confirmation checks.
- Receipts and order slips through core's print dialog; business name, address and tax ID.
- Recent terminal sales, paged owner sales, CSV exports of the visible page, and owner payment refresh.
- Separate Lightning tip wallets and Lightning-address revenue shares, subject to core background-payment grants.
- A separate customer display with websocket refresh hints and polling; mobile layout and live core theme updates.

Excluded from this port: Watchonly, cash recording, NFC/card-reader hardware, ATM/password flows, Inventory/Orders/Tabs integrations, remote image downloads and PWA installation. These need capabilities beyond the supported flow used here. Hosted fiat and on-chain tips stay in their respective receiving wallets.

## On-chain setup

Enable **On-chain payments** in the terminal settings and select one of your ready core on-chain wallets. Core handles wallet setup, address allocation and scanning. No Watchonly extension is used. PoS requests two additional extension permissions: `onchain.reserve_address_public`, limited to the saved checkout's wallet and terminal, and `onchain.payments.read`.

Sales wait for the full amount and at least one confirmation by default. Owners can explicitly enable **Accept on-chain payment at 0-conf** per terminal. Partial payments remain pending and multiple payments to the checkout address are added together. The address, satoshi quote and confirmation rule are fixed when the checkout is created; there is no automatic on-chain quote expiry. An accepted sale remains paid in the receipt history. On-chain tips stay in the receiving wallet; Lightning tip forwarding and revenue sharing do not run for on-chain sales.

On-chain logic is in `src/onchain.js`. The extension saves the checkout before reserving an address and saves the returned address and private status token before showing a QR. Repeated submissions reuse that receipt. Core allocates a new address on every reservation call, so an uncertain allocation or save stays in review and is never automatically retried. Check the core wallet before starting a replacement sale; an allocation whose response was lost cannot be recovered through this host API.

Core rejects status reads before a fresh scan exists, during scans and after wallet changes invalidate a checkout token. Its host errors abort the WASM call, so saved receipts are read separately from status polling. The cashier and display retain the saved QR while status is unavailable. Neither wallet IDs nor status tokens are returned to the browser. Public input cannot select the owner, receiving wallet, confirmation rule or expected amount.

## Access and payment rules

Core owns authentication. The iframe has no wallet keys or direct network access. Private storage is scoped to the invocation owner. Settings accept only wallets returned for that owner. There are no APIs for choosing a different owner.

A staff link is a secret capability: its holder can create invoices and read that terminal's recent receipts. A separate display link can only read the latest checkout. Public calls first resolve the owner from the saved link, then verify its role, revocation state and terminal. Wallet IDs, payout destinations and other terminals' data are omitted from public responses. Replace links to revoke shared access.

The server calculates prices, tax and tips. A checkout stores its cart, wallet, provider, rate and payout destinations before requesting an invoice. Retrying the same action reuses that checkout; a changed cart is rejected. The browser saves the action before sending it so a page reload can resume it. An uncertain invoice creation is kept for review instead of automatically creating another invoice. A verified paid event can recover a lost invoice response.

Only core's bound invoice status, a rechecked paid event, or core's token-bound on-chain totals can mark a sale paid. Browser messages and websocket messages are never payment proof. Owner refresh can ask core to refresh a pending Lightning payment or read the saved on-chain address's scanned totals. It does not send payouts using authenticated spending permissions.

Automatic tips and revenue shares require an explicit core background-payment grant for the receiving wallet. Core controls its amount and destination limits. Each payout attempt is saved before sending. `pending` or `review` payouts are never automatically retried: inspect the wallet payment before taking any manual action. Fees can prevent a payout when the receiving wallet has insufficient spare funds. Use an owned, spendable Lightning wallet for splits.

All exports use core's per-owner `sync` lock. This lock is process-local: run one LNbits worker for this extension. Multiple workers sharing the same database are not supported for checkout/payout serialization.

## Limits

- 50 terminals per owner; 100 products per terminal; catalog settings up to 48 KB.
- 100 lines per cart; quantity 1–999; maximum Bitcoin charge 1 billion sats.
- One new checkout per terminal every two seconds; at most 100 open checkouts. Refresh pending sales from the owner screen when necessary.
- Six held carts, subject to core's device-storage quota. Held carts are not paid receipts. Core storage can expire or be cleared.
- Checkout recovery is per browser tab and staff link. Starting a separate sale is an explicit cashier choice; an earlier invoice may still be payable.
- PNG/JPEG/WebP data images only, at most 8 KB each and within the total catalog limit. External images are rejected.
- Historical reports retain their sale-time settings. CSV export covers the displayed page of 50 sales.

## Development and checks

Work in `<LNbits data folder>/wasm_extensions/pos`. All business logic is in `src/`; `ui/` contains the sandbox UI; `storage/` contains the new schema and JSON migration; `wasm/lnbits-extension.wit` declares the existing host imports. No core changes are required.

Dependencies are pinned in `package.json` and `package-lock.json`: Vue, QRCode, esbuild, Vue's SFC compiler, Jco and ComponentizeJS. The build precompiles Vue templates, bundles local assets and compiles the JavaScript guest into a WASM component. The UI loads core’s Vue, Quasar, Material Icons and LNbits CSS through the allowed asset proxy. It uses standard Quasar controls and follows core’s theme name, colors, dark mode and gradient setting; extension CSS only handles layout. It does not need runtime template evaluation or a CDN. Use Node.js 24.

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
LNBITS_CORE_PATH=/path/to/lnbits make test-ui
LNBITS_CORE_PATH=/path/to/lnbits make test-host PYTHON=/path/to/lnbits/.venv/bin/python
make package
```

`test-host` executes the compiled component against core's actual host imports. It checks real on-chain address allocation, bound tokens, retries, partial/confirmed payments, stale scans and owner isolation using temporary wallets and synthetic scan data. It also checks core's query-parameter conversion for payment status. `package` creates `dist/pos-0.3.0.zip` with only the runtime files. Core must install this release ZIP, not a GitHub source ZIP: source includes a Python test helper, which is deliberately excluded from the WASM release. Reactivate the extension (or restart the development server) after rebuilding so core warms the new component before serving requests.

`test-ui` executes core's real Vue and Quasar scripts in entrypoint order with small browser stubs. It catches startup failures such as loading Quasar before `document.body` exists, and checks dark/light mode with origin storage unavailable. It does not replace visual browser checks.

GitHub Actions runs `make check` on pull requests and pushes to `main`, then builds with Node.js 24 and `npm ci`, checks that committed browser assets are current, and packages the extension. It runs `make test-ui` and tests the extracted ZIP with `make test-host` against core commit `4cfe9e6e471e71a3087b74d1c776b74054b4822a`, which includes the required public on-chain reservation API and bigint status bindings. Core uses Python 3.12 and its locked runtime dependencies. These checks use temporary databases and mocked payments. The tested ZIP and SHA-256 checksum are kept as workflow artifacts for 14 days. Update the pinned core commit in `.github/workflows/ci.yml` when changing host API requirements.

Pushing a stable `vX.Y.Z` tag runs the same checks and publishes that tested ZIP and checksum as GitHub release assets. The tag, extension manifest, npm package and lockfile versions must agree. Pull requests have read-only repository permissions; only the tagged release job can publish. No extra secrets are needed, and the workflow can also be run manually.

Verified: `make check` (51 tests), `make package`, `make test-ui` and `make test-host`; real core on-chain allocation, token checks, confirmation rules and allocation failures are exercised with temporary wallets and synthetic scan data. HTTP checks cover the local owner page, metadata and terminal list, with served UI assets matching the build. Earlier HTTP checks also covered anonymous Lightning checkout, retry reuse, customer-display data and paid status. No real-money payments were used. The production dependency audit is clean; the full audit reports a moderate minimatch issue in Jco's development-only dependency chain.

Before production use, finish a manual browser check through the real core wrapper, including desktop/mobile checkout, display updates and print/CSV/payment-permission dialogs. Live Bitcoin transactions, hosted fiat and external revenue payouts have not been exercised with live providers.

## Brand assets

The extension name is **PoS**. The transparent logo is in `static/assets/icon.png`, used by the core extension list and the PoS header. It was generated with the built-in image generation tool.

<details>
<summary>Logo prompt</summary>

Use case: logo-brand. Asset type: square app icon for the LNbits PoS point-of-sale extension. Create one crisp, distinctive flat logo: a compact payment terminal / receipt silhouette with a lightning bolt cleverly cut into its center. Solid Bitcoin orange body, clean white bolt detail, generous transparent margin. A clear, friendly geometric mark that stays legible at 32 pixels, with balanced thick shapes, precise edges and a subtle receipt-paper notch. No words, no letters, no currency symbols, no slogan, no gradients, no shadows, no 3D, no mockup, no border or background tile outside the mark. Transparent background with real alpha. This is only a logo asset; the product keeps its existing core UI and the name PoS.

</details>

## License

MIT. TPoS is the feature reference; this is a separate WASM extension with fresh storage.
