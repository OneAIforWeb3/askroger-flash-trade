# askroger-flash-trade

Trade the signal. A Flash (Definitive) trading module for [askRoger](https://app.askroger.ai), built during ETHGlobal Mumbai (Nov 5 to 7, 2026) on the Continuity track.

askRoger ranks tokens by what is happening on X: mentions, KOL activity, smart followers, launch risk flags. This module adds the missing step. From a token page you place a Flash **limit** or **market** order without leaving the page. Flash executes non-custodially and pays the execution gas; your tokens stay in your wallet until the order fills.

Verified live on Base on 2026-11-05 (UTC): a market buy filled onchain, two limit orders rested below spot and were cancelled from the Orders tab, all mirrored in askRoger's order table.

## What existed before the hackathon

- askRoger webapp (private repo): token leaderboard, token pages, signal alerts, watchlists, referral "Trade" links to GMGN, Photon, Uniswap, Banana Gun.
- askRoger Flask API (private repo): login JWT, tiering, data endpoints.
- No wallet connection and no order execution of any kind.

## What was built during the event (this repo)

Two folders, published with their full commit history via `git subtree split` from the private repos. Every commit is timestamped after the 21:00 IST kick-off on Nov 5.

### `webapp-trade/` (React + TypeScript, Vite) = `src/features/trade/` in the webapp

- `TradeDrawer.tsx`: Market or Limit buy in USDC. Live quote preview (debounced, refreshed every 15 s while idle). Limit controls in the Matcha pattern: "When 1 TOKEN is worth", percent-vs-spot pill, presets Market / −2% / −5% / −10% / custom, Expires in (1h, 24h, 7d, GTC). Place flow: connect → explicit Place click → quote → approve USDC only when Flash asks → re-quote → Permit2 and EIP-712 signatures → submit → poll until filled. Filled card with average price, spent, fees, explorer link and share to X. Orders tab with cancel via `personal_sign`.
- `evmWallet.ts`: raw `window.ethereum` JSON-RPC helpers (connect, switch chain, send tx, `eth_signTypedData_v4`, `personal_sign`, receipt polling, ERC-20 balance). No SDK.
- `chains.ts`: Flash chain enum, EVM chain ids, USDC addresses, explorer URLs.
- `trade.service.ts`: typed calls to the Flask `/trade/*` proxy with a cache-busting query parameter.
- `useTradeStore.ts`, `useFlashEnabled.ts`, `FlashOrdersLine.tsx` (public "N Flash orders by M askRoger traders" caption), `share.ts`.

### `flask-trade/` (Flask blueprint) = `app/api/trade/` in the API

- Server-side proxy to `https://flash.definitive.fi/v1`: `POST /quote`, `POST /order`, `GET /orders`, `GET /orders/<id>`, `POST /orders/<id>/cancel`, public `GET /token/<chain>/<token>/orders`, `GET /status`.
- Holds the Flash API key and pins the integrator fee (`flashIntegratorFeeBps`). Validates chain and order type, strips quote-only fields from the submit, passes Flash's status and error body through unchanged, sends `Cache-Control: no-store`.
- Records orders in `users.flash_orders` (DDL in `constants.py`) and keeps their status in sync from the order list and single-order reads.
- `test_trade_routes.py`: hermetic tests, no network or database.

### Glue in the private repos (described, not included)

- Webapp: one "Trade with Flash" pill in the token page's Trade now strip, the caption component and the drawer mount, about 40 lines in `TokenPage.tsx`.
- API: one `app.register_blueprint(trade_bp, url_prefix="/trade")` line in the app factory.

## How it uses Flash

1. `POST /v1/quote` with `funderAddress`, `orderType` `market` or `limit`, `limitNotionalPrice`, `expireTime`, `flashIntegratorFeeBps`.
2. If the quote returns `evm.approveTx`, the wallet sends it once per token.
3. If the quote returns `evm.permitTypedData`, the wallet signs it (Permit2). The wallet signs `evm.orderTypedData` with `eth_signTypedData_v4` (`domain.chainId` coerced to a number, as in Definitive's reference client).
4. `POST /v1/order` with the quote fields echoed, `quoteId`, `userSignature` and the permit material.
5. `GET /v1/orders/{id}` until `ORDER_STATUS_FILLED`; the fill's `transactionId` links to the block explorer. A 404 in the first second after submit is tolerated. A failed submit is reconciled against the order list before being shown as failed, so it is never blindly retried.
6. Cancel: `personal_sign` of `Definitive Flash v1 — Cancel Order\nOrder: <id>` then `POST /v1/orders/{id}/cancel`.

## Run

Frontend: drop `webapp-trade/` into a Vite + React app as `src/features/trade/`, provide an axios client at `@lib/api` named `apiClientNew` that targets the API with auth headers, provide `CHAIN_ICONS` at `@constants/constants`, and mount `<TradeDrawer />` plus a button that calls `useTradeStore().openDrawer(tokenRow)`.

Backend: copy `flask-trade/` to `app/api/trade/`, register the blueprint under `/trade`, set `FLASH_API_KEY` and `FLASH_INTEGRATOR_FEE_BPS` in the environment, run the DDL in `constants.CREATE_TABLE_DDL`, and provide a `require_login` decorator at `app.api.custom_decorators` that sets `g.tg_id`.

```bash
python3 -m pytest flask-trade/test_trade_routes.py -v
```

## Links

- Flash docs: https://flash.definitive.fi/docs
- Demo video: added at submission

## License

MIT
