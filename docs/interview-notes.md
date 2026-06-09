# Interview and Client Notes

## 30-second pitch

I built Collateral Settlement Gateway, a Web3 backend and smart-contract reference implementation for applications that need on-chain collateral custody and auditable settlement of off-chain actions. Users deposit collateral into a Vault, sign off-chain actions with EIP-712, external apps run their business logic, and the gateway settles the final result on-chain with a unique `settlementId` and `reasonHash`. Trading is included as a reference app, but the gateway can support other off-chain applications as well.

## 2-minute architecture explanation

The system separates custody/finality from application execution. The Solidity `CollateralVault` holds collateral, tracks insurance liquidity, applies settlement deltas, and controls withdrawal accounting. The TypeScript/Fastify backend verifies wallet-signed intents, authenticates external apps, links settlements to signed user actions, submits final settlement transactions, indexes Vault events, and exposes reconciliation reports. The Operator Console provides visibility into system health, settlements, withdrawals, and reconciliation. A trading reference app demonstrates low-latency off-chain logic with on-chain settlement.

## Important trade-offs

- The operator is trusted to submit correct settlement.
- Settlement is auditable, not trustless.
- The trading module is intentionally scoped as a reference app.
- The repository is designed for demonstration, evaluation, and further development, not real-funds deployment.

## Strong technical points to show

- `CollateralVault.sol`
- EIP-712 signed intent service
- app registry and admin auth
- settlement report
- user-signed withdrawal flow
- reconciliation service
- external-client example
- Operator Console
- contract, backend, and end-to-end tests
