import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import type { HexAddress, HexString, SignedIntent } from "./types.js";

export const SIGNED_INTENT_EIP712_TYPES = {
  SignedIntent: [
    { name: "userAddress", type: "address" },
    { name: "appId", type: "string" },
    { name: "intentType", type: "string" },
    { name: "payloadHash", type: "bytes32" },
    { name: "nonce", type: "string" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export type SignedIntentTypedData = ReturnType<
  typeof buildSignedIntentTypedData
>;

export function buildSignedIntentTypedData(args: {
  chainId: number;
  verifyingContract: Address;
  intent: SignedIntent;
}) {
  const intent = normalizeSignedIntent(args.intent);

  return {
    domain: {
      name: "Collateral Settlement Gateway",
      version: "1",
      chainId: args.chainId,
      verifyingContract: args.verifyingContract,
    },
    types: SIGNED_INTENT_EIP712_TYPES,
    primaryType: "SignedIntent" as const,
    message: {
      userAddress: getAddress(intent.userAddress),
      appId: intent.appId,
      intentType: intent.intentType,
      payloadHash: intent.payloadHash,
      nonce: intent.nonce,
      deadline: BigInt(intent.deadline),
    },
  };
}

export function hashPayload(payload: unknown): HexString {
  return keccak256(toHex(stableStringify(payload)));
}

export function normalizeSignedIntent(intent: SignedIntent): SignedIntent {
  if (!/^0x[a-fA-F0-9]{64}$/.test(intent.payloadHash)) {
    throw new Error("Signed intent payloadHash must be bytes32");
  }

  return {
    userAddress: getAddress(intent.userAddress) as HexAddress,
    appId: intent.appId.trim(),
    intentType: intent.intentType.trim().toUpperCase(),
    payloadHash: intent.payloadHash.toLowerCase() as Hex,
    nonce: intent.nonce.trim(),
    deadline: intent.deadline,
  };
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
