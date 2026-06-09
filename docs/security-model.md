# Security Model

Collateral Settlement Gateway is an auditable trusted-operator reference implementation. It is not a production exchange, not a trustless protocol, and must not be used with real funds without substantial hardening and audits.

## Trust assumptions

- **The operator is trusted.** The backend/operator submits final settlement and approval transactions.
- **Users sign intents.** Product actions are authorized through EIP-712 signed messages.
- **External apps are authorized.** App-auth settlement uses `X-App-Id` and `X-App-Secret` from the configured registry.
- **Settlement is auditable.** Settlement records include `settlementId`, `reasonHash`, app references, linked signed intents, and on-chain transaction data.
- **Withdrawals are guarded.** Product withdrawal requests require signed user intent and operator approval.
- **Reconciliation is a detector, not a mathematical proof.** It helps identify mismatch between backend state and Vault state.

## Protected surfaces

- `POST /settlements` requires admin bearer auth or app credentials.
- App-auth settlements require linked signed intents.
- `POST /withdrawals/approve/:userAddress` requires admin bearer auth.
- `/admin/*` requires admin bearer auth.
- Demo routes are disabled by default and require admin auth when enabled.

## Known limitations

- Trusted operator settlement.
- No decentralized dispute resolution.
- No contract audit.
- No backend security audit.
- Env-based app registry.
- SQLite storage in the reference implementation.
- SQLite still stores readable decimal fields for developer clarity; calculations are centralized in `backend/src/core/money/money.ts` and contract calls use token-native microUSDC units. Production financial accounting should use fixed-point integer storage end-to-end.
- No production-grade oracle policy.
- No liquidation engine or full order book.
- No high-availability deployment.

## Required hardening before real value

- Smart-contract audit.
- Backend security review.
- Role-based access control.
- Hashed app secrets and secret rotation.
- Multisig or governed operator signer.
- Durable database with migrations and backups.
- Reorg-aware indexer.
- Monitoring and alerting.
- Incident response runbook.
- Deployment-specific legal and compliance review.
