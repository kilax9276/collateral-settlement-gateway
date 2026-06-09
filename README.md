# Collateral Settlement Gateway

**On-chain collateral. Off-chain speed. Auditable settlement.**

Collateral Settlement Gateway is a professional Web3 reference implementation for applications that need to hold user collateral on-chain while executing fast business logic off-chain. It combines a Solidity Vault, EIP-712 wallet-signed intents, app-authorized settlements, guarded withdrawals, settlement audit reports, reconciliation, and an Operator Console into one coherent developer project.

The repository includes a trading reference application to demonstrate the pattern in a financial workflow. The gateway itself is broader: it can support prediction markets, collateralized games, reward engines, trading competitions, risk simulations, derivatives experiments, and other off-chain applications that need a verifiable settlement layer.

> This is a developer-grade reference architecture. It is not a finished exchange, not a trustless protocol, and not intended for real funds without audits, hardening, and operational controls.

---

## Why this project exists

Many Web3 products face the same architectural conflict:

- blockchains provide custody, settlement transparency, and verifiable events;
- application logic often needs to respond faster than a public chain can finalize transactions;
- users still need proof that deposits, withdrawals, and final balances are not arbitrary backend numbers.

Collateral Settlement Gateway solves that gap by separating responsibilities:

| Layer            | Responsibility                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Smart contracts  | Collateral custody, insurance liquidity, guarded withdrawals, final settlement events                             |
| Gateway backend  | Signed intent verification, app authorization, off-chain business workflows, settlement submission, audit reports |
| External apps    | Product-specific logic such as rewards, predictions, game outcomes, or trading calculations                       |
| Operator Console | Visibility into health, metrics, reconciliation, settlements, and system activity                                 |

The result is a reusable pattern: **fast off-chain execution with on-chain collateral anchoring and auditability**.

---

## What it is useful for

This repository is useful for founders, backend engineers, Web3 teams, and technical evaluators who want to see how hybrid on-chain/off-chain financial infrastructure can be structured.

Potential use cases:

- **Trading competitions** — users deposit collateral, trade simulated markets off-chain, and settle results on-chain.
- **Prediction markets** — users sign off-chain participation intents, the app resolves outcomes, and the gateway settles rewards.
- **Collateralized games** — game logic runs off-chain while user deposits and payouts remain anchored to the Vault.
- **Reward systems** — external apps submit reward settlements linked to signed user actions.
- **Derivatives experiments** — positions and risk can be calculated quickly off-chain while settlement stays auditable.
- **Internal risk simulations** — teams can model settlement workflows without building a custody stack from scratch.

---

## Core capabilities

- Solidity `CollateralVault` for deposits, insurance liquidity, settlement, and guarded withdrawals.
- Local/test `MockUSDC` token with USDC-like 6 decimals.
- Generic EIP-712 `SignedIntent` model for wallet-authorized off-chain actions.
- App authorization through `X-App-Id` and `X-App-Secret`.
- Admin/operator authorization through bearer token.
- Generic settlement API with `settlementId`, `reasonHash`, `referenceIds`, and linked `signedIntentIds`.
- Settlement audit reports connecting signed intents, off-chain references, and on-chain events.
- User-signed withdrawal requests plus operator approval.
- Blockchain indexer for Vault events.
- Reconciliation between backend state and smart-contract state.
- Fastify API with Swagger/OpenAPI documentation.
- SQLite-backed local persistence with in-memory mode for tests.
- WebSocket event stream.
- Static Operator Console.
- Standalone external-client integration example.
- Trading reference application with signed orders, position tracking, P&L, fees, and on-chain settlement.

---

## Architecture

```mermaid
flowchart LR
  Wallet[User wallet] -->|deposit / withdraw tx| Vault[CollateralVault]
  Wallet -->|EIP-712 SignedIntent| API[Gateway API]
  ExternalApp[External app] -->|X-App-Id + X-App-Secret| API
  Operator[Operator/Admin] -->|Bearer token| API

  subgraph Chain[On-chain layer]
    Token[MockUSDC local/test token]
    Vault
    Events[Vault events]
    Token --> Vault
    Vault --> Events
  end

  subgraph Gateway[Core gateway]
    API --> Registry[App Registry]
    API --> Intent[SignedIntent Service]
    API --> Settlement[Settlement Service]
    API --> Withdrawal[Withdrawal Service]
    API --> Ledger[SQLite / In-memory Ledger]
    API --> Admin[Admin + Metrics]
    API --> WS[WebSocket Events]
    Indexer[Blockchain Indexer] --> Ledger
    Reconciliation[Reconciliation Service] --> Ledger
    Events --> Indexer
    Settlement -->|settle delta| Vault
    Withdrawal -->|request / approve| Vault
  end

  subgraph Examples[Reference apps]
    Trading[Trading Example]
    ExternalClient[Standalone External Client]
    Trading --> Settlement
    ExternalClient --> API
  end

  subgraph UI[Operator UI]
    Console[Operator Console]
    Console --> API
  end
```

Backend layout:

```text
backend/src/
  core/
    auth/             # Signed intents, app registry, admin auth
    blockchain/       # Vault event indexing
    collateral/       # collateral-facing routes and contract metadata
    settlement/       # generic settlement service and audit reports
    withdrawals/      # signed withdrawal request and approval flow
    reconciliation/   # on-chain/off-chain state comparison
    storage/          # memory and SQLite repositories
    websocket/        # realtime event hub
    money/            # centralized money conversion helpers
    risk/             # reusable risk checks
  examples/
    trading/          # trading reference application
  demo/               # local walkthrough helpers
  admin/              # metrics, recent records, system health
```

---

## Gateway flow

1. **Deposit collateral** — a user deposits test collateral into `CollateralVault`.
2. **Index the event** — the backend indexer observes Vault events and updates the gateway ledger.
3. **Sign an intent** — the user authorizes an off-chain action with an EIP-712 `SignedIntent`.
4. **Run app logic** — an external app or reference module performs fast off-chain business logic.
5. **Submit settlement** — the app sends an authorized settlement request with linked signed intents.
6. **Apply on-chain delta** — the gateway submits the final balance delta to the Vault.
7. **Generate audit report** — settlement can be traced through `settlementId`, `reasonHash`, references, signed intents, and transaction hash.
8. **Request withdrawal** — a user signs a withdrawal intent; the operator approves it after risk checks.
9. **Reconcile** — admin endpoints compare backend ledger state and Vault state.

---

## Trading reference application

The trading module demonstrates the gateway pattern in a concrete financial workflow:

- user deposits collateral;
- user signs a trading order intent;
- the backend executes a market order off-chain;
- P&L and fees are calculated;
- a `TRADING_PNL` settlement is submitted with linked intent IDs;
- the Vault applies the result on-chain;
- settlement reports connect trades, signed intents, and transaction data.

The trading module is intentionally scoped as a reference app. It is not a full exchange, order book, liquidation engine, or perpetual futures platform.

---

## Repository structure

```text
contracts/                         Solidity contracts
backend/src/core/                  Gateway core modules
backend/src/examples/trading/      Trading reference app
backend/src/admin/                 Operator/admin endpoints
backend/src/demo/                  Local walkthrough helpers
dashboard/                         Static Operator Console
examples/external-client/          Standalone integration example
scripts/                           Deployment, demo, reset, report scripts
test/                              Contract, backend, and end-to-end tests
docs/                              Architecture, operations, deployment, security, use cases
.github/                           CI workflow and contribution templates
```

---

## Requirements

- Node.js 22+
- npm 10+
- Linux/macOS shell or WSL
- Local ports:
  - `8545` for Hardhat JSON-RPC
  - `3000` for backend/API/dashboard

---

## Quick start

```bash
npm ci
cp .env.example .env
```

Terminal 1:

```bash
npm run chain
```

Terminal 2:

```bash
npm run deploy:local
npm run dev
```

Useful URLs:

```text
Health:       http://localhost:3000/health
Swagger UI:   http://localhost:3000/docs
OpenAPI JSON: http://localhost:3000/openapi.json
Dashboard:    http://localhost:3000/dashboard
```

Run the complete local flow:

```bash
npm run demo:e2e
```

Run the standalone external app integration example:

```bash
npm run example:external-client
```

---

## Common commands

```bash
npm run format:check
npm run lint
npm run build
npm run test:contracts
npm run test:backend
npm run test:e2e
npm test
npm audit --audit-level=critical --omit=dev
```

Reset local state:

```bash
npm run local:reset
```

Generate a settlement report from the CLI:

```bash
npm run settlement:report -- <settlementId>
```

---

## Environment configuration

Start from `.env.example`:

```dotenv
PORT=3000
HOST=0.0.0.0
RPC_URL=http://127.0.0.1:8545
CHAIN_ID=31337
CONTRACTS_FILE=backend/src/generated/contracts.json
GATEWAY_ADMIN_TOKEN=change-me-admin-token
REGISTERED_APPS=trading-example:change-me-trading-secret,fantasy-trading-app:change-me-external-secret
STORAGE_DRIVER=sqlite
SQLITE_PATH=backend/data/app.db
ENABLE_DEMO_ROUTES=false
```

Important notes:

- `backend/src/generated/contracts.json` is generated by the deploy script and should not be committed.
- `backend/src/generated/contracts.example.json` is a safe placeholder.
- `MockUSDC` is a local/test token only.
- Default secrets are for local development; replace them in any shared environment.

---

## API authentication

Admin/operator endpoints require:

```http
Authorization: Bearer <GATEWAY_ADMIN_TOKEN>
```

External app settlement requires either admin auth or app credentials:

```http
X-App-Id: fantasy-trading-app
X-App-Secret: change-me-external-secret
```

For app-authenticated settlements:

- `appId` must match the header;
- `settlementType` must be allowed for the app;
- `signedIntentIds` is required;
- every linked intent must be verified, unexpired, unconsumed, owned by the same user, and registered under the same app.

---

## API examples

Admin metrics:

```bash
curl -H "Authorization: Bearer change-me-admin-token" \
  http://localhost:3000/admin/gateway-metrics
```

Settlement report:

```bash
curl http://localhost:3000/settlements/<settlementId>/report
```

App-authorized settlement body:

```json
{
  "userAddress": "0x0000000000000000000000000000000000000001",
  "appId": "fantasy-trading-app",
  "settlementType": "EXTERNAL_APP_REWARD",
  "amountDelta": "+25",
  "reasonHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "referenceIds": ["round-001"],
  "signedIntentIds": ["intent_abc123"],
  "metadata": {
    "source": "external-client-example"
  }
}
```

User-signed withdrawal request:

```json
{
  "userAddress": "0x0000000000000000000000000000000000000001",
  "amount": 1000,
  "signedIntentId": "intent_withdrawal_123"
}
```

---

## Operator Console

The dashboard is available at:

```text
http://localhost:3000/dashboard
```

Tabs:

- **Gateway Overview** — system health, chain, Vault, indexer, collateral, insurance, liabilities, and operation metrics.
- **Settlement Audit** — lookup by `settlementId`, linked intents, reason hash, transaction data.
- **Reconciliation** — compare backend ledger and Vault state.
- **Trading Example** — reference trading workflow and current example state.
- **Demo Walkthrough** — local-only guided flow; disabled unless `ENABLE_DEMO_ROUTES=true`.

---

## Deployment overview

For local development, use Hardhat + Fastify:

```bash
npm run chain
npm run deploy:local
npm run dev
```

For a server deployment, use the deployment guide:

- [Deployment Guide](docs/deployment.md)
- [Operations Guide](docs/operations.md)
- [Security Model](docs/security-model.md)

High-level production-style steps:

1. provision a Linux host;
2. install Node.js 22+ and npm;
3. configure a managed RPC endpoint;
4. configure secrets through environment variables or a secrets manager;
5. deploy or point to contracts;
6. run the backend behind a reverse proxy with TLS;
7. run the process under systemd or a process supervisor;
8. disable demo routes;
9. set real admin tokens and app credentials;
10. monitor indexer lag, reconciliation status, settlement failures, and Vault liquidity.

---

## Testnet deployment

Supported scripts:

```bash
npm run deploy:sepolia
npm run deploy:arbitrum-sepolia
npm run verify:sepolia
npm run verify:arbitrum-sepolia
```

Testnet deployment is a developer workflow. It does not make the system suitable for real funds.

---

## Quality checks

The project is expected to pass:

```bash
npm ci
npm run format:check
npm run lint
npm run build
npm test
npm run test:e2e
npm audit --audit-level=critical --omit=dev
```

A GitHub Actions workflow is included under `.github/workflows/ci.yml`.

---

## Security model

The current model is explicit:

- users hold wallets and sign off-chain intents;
- collateral is held in the Vault contract;
- external apps are authenticated before submitting settlement;
- admin/operator endpoints require bearer authorization;
- settlement is operator-submitted and auditable through reports;
- withdrawals require user-signed intent plus operator approval;
- reconciliation detects backend/on-chain mismatch.

The system is **auditable, not trustless**. The operator remains trusted to submit correct settlements. Do not use real funds without a smart-contract audit, backend security review, stronger key management, robust monitoring, and formal operations procedures.

See [SECURITY.md](SECURITY.md) and [docs/security-model.md](docs/security-model.md).

---

## Known limitations

- Trusted operator settlement model.
- No decentralized dispute resolution.
- No smart-contract audit.
- No backend security audit.
- Env-based app registry; production should use a managed registry with hashed secrets and rotation.
- SQLite persistence for local/reference use.
- Some readable decimal fields remain in storage for developer clarity; token-native contract calls use microUSDC units.
- No production oracle policy.
- No liquidation engine.
- No full order book.
- No high-availability deployment.
- Demo routes are local walkthrough helpers and must stay disabled outside controlled environments.

---

## Roadmap

See [ROADMAP.md](ROADMAP.md). Key future directions:

- fixed-point integer storage end-to-end;
- Postgres migrations and operational backups;
- DB-managed app registry with secret rotation;
- RBAC for admin/operator access;
- multisig or governed operator signer;
- settlement batching and review windows;
- oracle policy with freshness/confidence constraints;
- indexer reorg handling and confirmation depth;
- monitoring and alerting;
- smart-contract audit and backend security review.

---

## Project positioning

**Short version**

Collateral Settlement Gateway is reusable Web3 infrastructure for apps that need fast off-chain logic while keeping collateral custody and final settlement anchored on-chain.

**Technical version**

The system combines a Solidity Vault, EIP-712 signed intents, app-authenticated settlement, audited reason hashes, operator approval workflows, reconciliation, and a trading reference application to demonstrate how hybrid financial products can separate speed from finality.

---

## License

MIT. See [LICENSE](LICENSE).
