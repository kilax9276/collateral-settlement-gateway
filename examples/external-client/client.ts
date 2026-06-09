import {
  getAddress,
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { buildSignedIntentTypedData, hashPayload } from "./signedIntent.js";
import type { SignedIntentTypedData } from "./signedIntent.js";
import type {
  HexAddress,
  HexString,
  LinkedSignedIntentReport,
  SettlementRecord,
  SignedIntent,
  VerifiedSignedIntent,
} from "./types.js";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:3000";
const DEFAULT_APP_ID = "fantasy-trading-app";
const DEFAULT_SETTLEMENT_TYPE = "EXTERNAL_APP_REWARD";
const DEFAULT_REWARD_AMOUNT = "+25";
const LOCAL_HARDHAT_MNEMONIC =
  "test test test test test test test test test test test junk";

type ContractsResponse = {
  chainId?: number;
  collateralVault?: { address?: string | null };
};

type NonceResponse = {
  userAddress: HexAddress;
  nonce: string;
  issuedAt: string;
};

type PortfolioResponse = {
  userAddress: HexAddress;
  collateral: number;
  equity: number;
  freeCollateral: number;
  pendingSettlementPnl: number;
  settlements: SettlementRecord[];
};

type SettlementResponse = {
  settlement: SettlementRecord;
  portfolio: PortfolioResponse;
};

type SettlementAuditReport = {
  settlementId: HexString;
  userAddress: HexAddress;
  appId: string;
  settlementType: string;
  amountDelta: number;
  reasonHash: HexString;
  referenceIds: string[];
  metadata?: Record<string, unknown>;
  signedIntentIds: string[];
  linkedSignedIntents?: LinkedSignedIntentReport[];
  onChain: {
    txHash: string;
    blockNumber: string | null;
    eventName: string;
    contractAddress: HexAddress | null;
  };
  status: string;
  createdAt: string;
  confirmedAt: string | null;
};

type ExternalRewardPayload = {
  appId: string;
  userAddress: HexAddress;
  action: "awardReward";
  roundId: string;
  marketId: string;
  rewardAmount: string;
  rewardAsset: "mUSDC";
  outcome: string;
};

async function main(): Promise<void> {
  const gatewayUrl = stripTrailingSlash(
    process.env.GATEWAY_URL ?? DEFAULT_GATEWAY_URL,
  );
  const appId = process.env.EXTERNAL_APP_ID ?? DEFAULT_APP_ID;
  const appSecret =
    process.env.EXTERNAL_APP_SECRET ?? "change-me-external-secret";
  const settlementType =
    process.env.EXTERNAL_SETTLEMENT_TYPE ?? DEFAULT_SETTLEMENT_TYPE;
  const rewardAmount =
    process.env.EXTERNAL_REWARD_AMOUNT ?? DEFAULT_REWARD_AMOUNT;
  const account = resolveAccount();
  const userAddress = getAddress(account.address) as HexAddress;

  const contracts = await tryReadContracts(gatewayUrl);
  const chainId = Number(process.env.CHAIN_ID ?? contracts?.chainId ?? 31337);
  const verifyingContract = resolveVerifyingContract(contracts);

  console.log("External client example");
  console.log("=======================");
  console.log(`Gateway: ${gatewayUrl}`);
  console.log(`App ID: ${appId}`);
  console.log(`User: ${userAddress}`);
  console.log(`Chain ID: ${chainId}`);
  console.log(`Verifying contract: ${verifyingContract}`);

  const nonce = await getJson<NonceResponse>(
    `${gatewayUrl}/auth/nonce/${userAddress}`,
  );

  const rewardPayload: ExternalRewardPayload = {
    appId,
    userAddress,
    action: "awardReward",
    roundId: process.env.EXTERNAL_ROUND_ID ?? "fantasy-round-001",
    marketId: process.env.EXTERNAL_MARKET_ID ?? "weekly-btc-contest",
    rewardAmount,
    rewardAsset: "mUSDC",
    outcome: process.env.EXTERNAL_OUTCOME ?? "top-10-finish",
  };
  const payloadHash = hashPayload(rewardPayload);
  const reasonHash = payloadHash;
  const intent: SignedIntent = {
    userAddress,
    appId,
    intentType: settlementType,
    payloadHash,
    nonce: nonce.nonce,
    deadline: Math.floor(Date.now() / 1000) + 300,
  };

  const typedData: SignedIntentTypedData = buildSignedIntentTypedData({
    chainId,
    verifyingContract,
    intent,
  });
  const signature = await account.signTypedData(typedData);

  const verifiedIntent = await postJson<VerifiedSignedIntent>(
    `${gatewayUrl}/intents/verify`,
    { intent, signature },
  );
  console.log(`Verified intent: ${verifiedIntent.intentId}`);

  const portfolioBefore = await getJson<PortfolioResponse>(
    `${gatewayUrl}/portfolio/${userAddress}`,
  );
  console.log(
    `Collateral before settlement: ${portfolioBefore.collateral} mUSDC`,
  );

  const settlementResult = await postJson<SettlementResponse>(
    `${gatewayUrl}/settlements`,
    {
      userAddress,
      appId,
      settlementType,
      amountDelta: rewardAmount,
      reasonHash,
      referenceIds: [rewardPayload.roundId, rewardPayload.marketId],
      signedIntentIds: [verifiedIntent.intentId],
      metadata: {
        externalClient: "examples/external-client",
        payload: rewardPayload,
        verifiedIntentId: verifiedIntent.intentId,
      },
    },
    { "x-app-id": appId, "x-app-secret": appSecret },
  );
  console.log(
    `Settlement submitted: ${settlementResult.settlement.settlementId}`,
  );

  const report = await getJson<SettlementAuditReport>(
    `${gatewayUrl}/settlements/${settlementResult.settlement.settlementId}/report`,
  );

  console.log("\nSettlement report");
  console.log("-----------------");
  console.log(`Settlement ID: ${report.settlementId}`);
  console.log(`User: ${report.userAddress}`);
  console.log(`Settlement Type: ${report.settlementType}`);
  console.log(`Amount Delta: ${report.amountDelta}`);
  console.log(`Reason Hash: ${report.reasonHash}`);
  console.log(`Reference IDs: ${report.referenceIds.join(", ")}`);
  console.log(
    `Signed Intent IDs: ${report.signedIntentIds.length ? report.signedIntentIds.join(", ") : "none"}`,
  );
  console.log(`Tx Hash: ${report.onChain.txHash}`);
  console.log(`Block Number: ${report.onChain.blockNumber ?? "unknown"}`);
  console.log(`Event: ${report.onChain.eventName}`);
  console.log(`Final Status: ${report.status}`);
}

function resolveAccount() {
  const privateKey = (
    process.env.EXTERNAL_APP_PRIVATE_KEY ??
    process.env.EXTERNAL_CLIENT_PRIVATE_KEY
  )?.trim();
  if (privateKey) {
    return privateKeyToAccount(normalizePrivateKey(privateKey));
  }

  const accountIndex = Number(process.env.EXTERNAL_CLIENT_ACCOUNT_INDEX ?? 1);
  return mnemonicToAccount(LOCAL_HARDHAT_MNEMONIC, { accountIndex });
}

async function tryReadContracts(
  gatewayUrl: string,
): Promise<ContractsResponse | null> {
  try {
    return await getJson<ContractsResponse>(`${gatewayUrl}/contracts`);
  } catch {
    return null;
  }
}

function resolveVerifyingContract(
  contracts: ContractsResponse | null,
): Address {
  const address = contracts?.collateralVault?.address;
  if (address && isAddress(address)) return getAddress(address);
  return zeroAddress;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  return parseJsonResponse<T>(response, "GET", url);
}

async function postJson<T>(
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  return parseJsonResponse<T>(response, "POST", url);
}

async function parseJsonResponse<T>(
  response: Response,
  method: string,
  url: string,
): Promise<T> {
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const detail =
      parsed && typeof parsed === "object" ? JSON.stringify(parsed) : text;
    throw new Error(
      `${method} ${url} failed with ${response.status}: ${detail}`,
    );
  }
  return parsed as T;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizePrivateKey(value: string): Hex {
  return (value.startsWith("0x") ? value : `0x${value}`) as Hex;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
