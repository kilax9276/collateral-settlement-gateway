# Roadmap

## Security and governance

- Role-based access control for admins, operators, viewers, and app managers.
- DB-managed app registry with hashed secrets and rotation.
- Multisig or governed operator signer.
- Formal smart-contract audit.
- Backend security review.

## Accounting and storage

- Fixed-point integer storage end-to-end.
- Postgres support with migrations.
- Durable backups and restore runbooks.
- Idempotent settlement retry workflow.

## Indexer and chain reliability

- Confirmation depth configuration.
- Reorg detection and recovery.
- Backfill from deployment block.
- Dead-letter queue for failed event processing.
- Indexer lag alerts.

## Product capabilities

- Settlement batching.
- Settlement review windows.
- App-specific settlement policies.
- Dispute workflow primitives.
- Richer Operator Console metrics and filters.

## Trading reference app

- Full fixed-point trading accounting.
- Short positions.
- Position limits by symbol.
- Oracle-backed market data policy.
- Liquidation reference flow.
- Order book or matching-engine example.

## Deployment

- Staging deployment guide.
- Testnet runbooks.
- Observability stack.
- Docker image publishing workflow.
