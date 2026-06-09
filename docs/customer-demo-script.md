# Customer Demo Script

Use this script to present the project as a reusable gateway, not as a narrow trading demo.

## 1. Position the project

Say:

> Collateral Settlement Gateway is a reusable Web3 backend and smart-contract layer for applications that need on-chain collateral, wallet-signed off-chain actions, app-authorized settlement, guarded withdrawals, and reconciliation. Trading is included as one reference application.

Avoid saying:

- it is a finished exchange;
- it is trustless;
- it is ready for real funds.

## 2. Show the architecture

Open `README.md` and the architecture diagram. Emphasize the separation:

- Vault handles custody and final settlement;
- backend handles signed intents, app authorization, settlement reports, and reconciliation;
- external apps provide business logic.

## 3. Run the complete flow

```bash
npm run chain
npm run deploy:local
npm run dev
npm run demo:e2e
```

Explain the flow:

```text
deposit → signed off-chain action → app logic → settlement → audit report → signed withdrawal → approval → withdraw
```

## 4. Open the Operator Console

```text
http://localhost:3000/dashboard
```

Show:

- Gateway Overview;
- Settlement Audit;
- Reconciliation;
- Trading Example;
- Demo Walkthrough.

## 5. Show the external client

```bash
npm run example:external-client
```

Explain that another app can integrate without importing backend internals.

## 6. Show the strongest technical points

- `CollateralVault.sol` for custody and settlement.
- EIP-712 `SignedIntent` verification.
- App registry and admin auth.
- Settlement linked to signed intents.
- User-signed withdrawal requests.
- Reconciliation service.
- Settlement audit report.

## 7. Close with scope and roadmap

Say:

> This is a strong foundation for hybrid Web3 products. The next steps for real deployment would be audits, RBAC, durable storage, better key management, testnet/staging runbooks, oracle policy, and operational monitoring.
