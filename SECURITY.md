# Security Policy

## Supported status

This repository is a reference implementation intended for evaluation, education, and further development. It is not approved for real funds.

## Reporting security issues

Please do not open public issues for sensitive vulnerabilities. Report privately by email:

```text
telegram @kilax9276
```

Include:

- affected component;
- reproduction steps;
- expected impact;
- suggested mitigation if known;
- whether private keys, user funds, or settlement integrity could be affected.

## Scope

In scope:

- Solidity contracts in `contracts/`;
- backend authorization and settlement logic;
- signed intent verification;
- withdrawal authorization;
- reconciliation correctness;
- deployment/configuration issues that could expose operator capabilities.

Out of scope:

- vulnerabilities in local demo private keys;
- issues that require `ENABLE_DEMO_ROUTES=true` in a public environment;
- social engineering;
- denial-of-service against local-only development scripts.

## Real-funds warning

Do not deploy this repository with real funds without:

- smart-contract audit;
- backend security review;
- strong key management;
- RBAC;
- monitored infrastructure;
- durable database and backups;
- incident response procedures;
- legal/compliance review.
