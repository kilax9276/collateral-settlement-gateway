# Operations Guide

This guide focuses on the day-to-day operational concerns of running Collateral Settlement Gateway in a controlled environment.

## Health checks

Public health endpoint:

```bash
curl http://localhost:3000/health
```

Admin metrics:

```bash
curl -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  http://localhost:3000/admin/gateway-metrics
```

Watch:

- chain ID and Vault address;
- indexer status;
- last processed block;
- storage status;
- insurance balance;
- total liabilities;
- pending settlements;
- pending withdrawals;
- reconciliation warnings;
- failed transaction submissions.

## Reconciliation

Run user-level reconciliation:

```bash
curl -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  http://localhost:3000/admin/reconciliation/<userAddress>
```

A healthy report should be `OK`. Investigate `WARNING` and `MISMATCH` states before approving withdrawals or submitting additional settlements for the same account.

## Settlement review

Fetch a report:

```bash
curl http://localhost:3000/settlements/<settlementId>/report
```

Review:

- `settlementId` uniqueness;
- `reasonHash`;
- `referenceIds`;
- linked signed intents;
- app ID;
- amount delta;
- on-chain transaction hash;
- Vault event data.

## Withdrawal approval

Approving withdrawals is an operator action. Before approval, confirm:

- the user has a verified withdrawal intent;
- the user has no open application risk that should block withdrawal;
- reconciliation is not mismatched;
- pending settlement does not change withdrawable collateral;
- the Vault has enough token liquidity.

## Incident handling

If settlement submission fails:

1. inspect backend logs;
2. check RPC status;
3. check operator key funding;
4. verify settlement record status;
5. verify whether the Vault already emitted the settlement event;
6. retry only if idempotency and `settlementId` status are clear.

If reconciliation reports mismatch:

1. pause operator approvals;
2. inspect indexed chain events;
3. confirm contract balances directly from RPC;
4. compare backend ledger records;
5. backfill indexer events if necessary;
6. document the correction path.

## Local state reset

```bash
npm run local:reset
```

Manual cleanup:

```bash
pkill -f "backend/src/server" || true
pkill -f "scripts/demo-e2e" || true
pkill -f "tsx" || true
rm -f backend/data/app.db backend/data/app.db-shm backend/data/app.db-wal
npm run local:reset
```
