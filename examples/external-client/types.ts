export type HexAddress = `0x${string}`;
export type HexString = `0x${string}`;

export type SignedIntent = {
  userAddress: HexAddress;
  appId: string;
  intentType: string;
  payloadHash: HexString;
  nonce: string;
  deadline: number;
};

export type VerifiedSignedIntent = {
  valid: true;
  signer: HexAddress;
  intent: SignedIntent;
  intentId: string;
  status: "VERIFIED";
  nonceConsumed: boolean;
};

export type SettlementRecord = {
  settlementId: HexString;
  reasonHash: HexString;
  userAddress: HexAddress;
  appId: string;
  settlementType: string;
  amountDelta: number;
  pnl: number;
  referenceIds: string[];
  signedIntentIds: string[];
  metadata?: Record<string, unknown>;
  status: "ONCHAIN_SUBMITTED" | "ONCHAIN_CONFIRMED";
  txHash: string;
  onChain: {
    txHash: string;
    blockNumber: string | null;
    eventName: string;
    contractAddress: HexAddress | null;
  };
  createdAt: string;
  confirmedAt: string | null;
  ts: string;
};

export type LinkedSignedIntentReport = {
  id: string;
  appId: string;
  intentType: string;
  payloadHash: HexString;
  nonce: string;
  signer: HexAddress;
  userAddress: HexAddress;
  deadline: number;
  status: "VERIFIED" | "CONSUMED" | "EXPIRED";
  createdAt: string;
  consumedAt?: string | null;
  consumedBySettlementId?: HexString | null;
};
