# API Guide

OpenAPI documentation is available at:

```text
http://localhost:3000/docs
http://localhost:3000/openapi.json
```

## Authentication

Admin/operator endpoints:

```http
Authorization: Bearer <GATEWAY_ADMIN_TOKEN>
```

External app endpoints:

```http
X-App-Id: <appId>
X-App-Secret: <appSecret>
```

## Core route groups

- Core Gateway
- Signed Intents
- Collateral
- Settlements
- Withdrawals
- Reconciliation
- Admin
- Trading Example
- Demo Only

## Signed intents

A signed intent is the generic user authorization primitive:

```json
{
  "userAddress": "0x...",
  "appId": "fantasy-trading-app",
  "intentType": "EXTERNAL_APP_REWARD",
  "payloadHash": "0x...bytes32",
  "nonce": "intentnonce_...",
  "deadline": 1790000000
}
```

The gateway verifies signer recovery, nonce, deadline, app registration, and replay protection.

## Settlements

App-authenticated settlements must include linked signed intents:

```json
{
  "userAddress": "0x...",
  "appId": "fantasy-trading-app",
  "settlementType": "EXTERNAL_APP_REWARD",
  "amountDelta": "+25",
  "reasonHash": "0x...bytes32",
  "referenceIds": ["round-001"],
  "signedIntentIds": ["intent_abc123"],
  "metadata": {
    "source": "external-client-example"
  }
}
```

## Reports

Settlement reports link on-chain and off-chain evidence:

```bash
curl http://localhost:3000/settlements/<settlementId>/report
```

## Withdrawals

A product-level withdrawal request requires a `WITHDRAWAL_REQUEST` signed intent. The operator approval step is separate and protected by admin auth.
