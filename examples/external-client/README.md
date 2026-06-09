# External client example

This example shows how a separate off-chain application can integrate with the Collateral Settlement Gateway as a standalone client. It does not import code from `backend/src`; it carries its own minimal EIP-712 helper in `signedIntent.ts` and local response/request types in `types.ts`.

The script models a small external app, `fantasy-trading-app`, that awards a user a `+25` mUSDC reward after an off-chain result. The app signs a generic `SignedIntent`, sends it to the gateway for verification/replay protection, submits a generic settlement with app credentials and the verified intent id, and then fetches the audit report.

## Files

```text
examples/external-client/
  README.md
  client.ts         # runnable standalone integration flow
  signedIntent.ts   # local EIP-712 SignedIntent typed-data helper
  types.ts          # local gateway API response/request types used by the example
```

## Flow

1. Call `GET /auth/nonce/:address`.
2. Build a generic `SignedIntent` locally:
   - `appId="fantasy-trading-app"`
   - `intentType="EXTERNAL_APP_REWARD"`
   - `payloadHash=keccak256(canonicalExternalRewardPayload)`
3. Sign the intent locally with EIP-712.
4. Submit `POST /intents/verify`.
5. Check the user's gateway snapshot with `GET /portfolio/:userAddress`.
6. Submit `POST /settlements` with:
   - `X-App-Id`
   - `X-App-Secret`
   - `settlementType="EXTERNAL_APP_REWARD"`
   - `amountDelta="+25"`
   - `reasonHash=payloadHash`
   - `signedIntentIds=[verifiedIntent.intentId]`
   - app-specific `referenceIds` and `metadata`
7. Read `GET /settlements/:settlementId/report`.

## Run

Start a local chain, deploy contracts, fund insurance liquidity, and run the backend first. For a local walkthrough you can use the normal demo setup:

```bash
npm ci
npm run local:chain
npm run local:deploy
ENABLE_DEMO_ROUTES=true npm run local:backend
```

In another terminal, run:

```bash
npm run example:external-client
```

Useful environment variables:

```dotenv
GATEWAY_URL=http://127.0.0.1:3000
EXTERNAL_APP_ID=fantasy-trading-app
EXTERNAL_APP_SECRET=change-me-external-secret
EXTERNAL_APP_PRIVATE_KEY=0x...
EXTERNAL_SETTLEMENT_TYPE=EXTERNAL_APP_REWARD
EXTERNAL_REWARD_AMOUNT=+25
EXTERNAL_CLIENT_ACCOUNT_INDEX=1
```

`EXTERNAL_APP_PRIVATE_KEY` is optional for the local demo. If it is not set, the script uses the local Hardhat mnemonic account at index `EXTERNAL_CLIENT_ACCOUNT_INDEX`, which defaults to Alice/account index `1`.

`POST /settlements` accepts registered app credentials in the reference implementation. The example sends `X-App-Id` and `X-App-Secret`, which must match the backend `REGISTERED_APPS` value. App-authenticated settlements must also include `signedIntentIds` that point to already verified intents for the same user and app. The default local registry includes `fantasy-trading-app:change-me-external-secret`; replace default secrets outside local demos.

`POST /intents/verify` remains public in this reference implementation, but it rejects intents whose `appId` is not registered.

## Why this matters

The gateway is not a trading backend with a hardcoded order flow. Trading is only one reference integration. Any off-chain application can bring its own payload, business logic, references and settlement type while reusing the gateway's generic signed-intent verification, collateral ledger, on-chain settlement, replay protection, intent consumption, and audit report.
