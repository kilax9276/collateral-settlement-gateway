import {
  getAddress,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import type { AppConfig } from "../../config.js";
import type {
  HexAddress,
  OrderNonce,
  OrderRequest,
  SignedIntent,
  SignedOrderPayload,
  VerifiedSignedIntent,
} from "../../types/domain.js";
import { conflict } from "../../utils/errors.js";
import {
  hasUsableVaultDeployment,
  loadContractsConfig,
} from "../../utils/contracts.js";
import type { Ledger } from "../storage/gatewayLedger.js";

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

export const COLLATERAL_GATEWAY_APP_ID = "collateral-gateway";
export const WITHDRAWAL_REQUEST_INTENT_TYPE = "WITHDRAWAL_REQUEST";

export type VerifySignedIntentOptions = {
  consumeNonce?: boolean;
  expectedAppId?: string;
  expectedIntentType?: string;
  expectedPayloadHash?: Hex;
};

export class SignedIntentService {
  constructor(
    private readonly ledger: Ledger,
    private readonly appConfig: AppConfig,
  ) {}

  issueNonce(userAddress: HexAddress): OrderNonce {
    const normalized = getAddress(userAddress) as HexAddress;
    const nonce = this.ledger.issueIntentNonce(normalized);
    return { ...nonce, userAddress: normalized };
  }

  async verifySignedIntent(
    intent: SignedIntent,
    signature: Hex,
    options: VerifySignedIntentOptions = {},
  ): Promise<VerifiedSignedIntent> {
    const normalizedIntent = normalizeSignedIntent(intent);
    const now = Math.floor(Date.now() / 1000);

    if (normalizedIntent.deadline < now) {
      throw conflict("INTENT_EXPIRED", "Signed intent deadline has passed");
    }

    if (
      options.expectedAppId &&
      normalizedIntent.appId !== options.expectedAppId
    ) {
      throw conflict(
        "INTENT_APP_MISMATCH",
        `Expected appId=${options.expectedAppId}, got ${normalizedIntent.appId}`,
      );
    }

    if (
      options.expectedIntentType &&
      normalizedIntent.intentType !== options.expectedIntentType
    ) {
      throw conflict(
        "INTENT_TYPE_MISMATCH",
        `Expected intentType=${options.expectedIntentType}, got ${normalizedIntent.intentType}`,
      );
    }

    if (
      options.expectedPayloadHash &&
      normalizedIntent.payloadHash.toLowerCase() !==
        options.expectedPayloadHash.toLowerCase()
    ) {
      throw conflict(
        "INTENT_PAYLOAD_HASH_MISMATCH",
        "Signed intent payloadHash does not match",
      );
    }

    const verifyingContract = await this.resolveVerifyingContract();
    let signer: Address;
    try {
      signer = await recoverTypedDataAddress({
        ...buildSignedIntentTypedData({
          chainId: this.appConfig.chainId,
          verifyingContract,
          intent: normalizedIntent,
        }),
        signature,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw conflict(
        "INVALID_INTENT_SIGNATURE",
        `Could not recover intent signer: ${message}`,
      );
    }

    if (getAddress(signer) !== getAddress(normalizedIntent.userAddress)) {
      throw conflict(
        "WRONG_INTENT_SIGNER",
        `Intent was signed by ${getAddress(signer)}, not ${getAddress(normalizedIntent.userAddress)}`,
      );
    }

    const consumeNonce = options.consumeNonce ?? true;
    if (consumeNonce) {
      this.ledger.consumeIntentNonce(
        normalizedIntent.userAddress,
        normalizedIntent.nonce,
      );
    }

    const verified = this.ledger.recordVerifiedIntent({
      intent: normalizedIntent,
      signature,
      signer: getAddress(signer) as HexAddress,
      status: "VERIFIED",
    });

    return {
      valid: true,
      signer: getAddress(signer) as HexAddress,
      intent: normalizedIntent,
      intentId: verified.id,
      status: "VERIFIED",
      nonceConsumed: consumeNonce,
    };
  }

  async verifySignedTradingOrder(
    order: OrderRequest,
    intent: SignedIntent,
    signature: Hex,
  ): Promise<OrderRequest> {
    const normalizedOrder = normalizeTradingOrder(order);
    const normalizedIntent = normalizeSignedIntent(intent);
    const expectedPayloadHash = hashTradingOrderPayload(normalizedOrder);

    if (
      getAddress(normalizedIntent.userAddress) !==
      getAddress(normalizedOrder.userAddress)
    ) {
      throw conflict(
        "TRADING_INTENT_USER_MISMATCH",
        "Trading order userAddress differs from intent",
      );
    }

    await this.verifySignedIntent(normalizedIntent, signature, {
      consumeNonce: true,
      expectedAppId: "trading-example",
      expectedIntentType: "TRADING_ORDER",
      expectedPayloadHash,
    });

    return normalizedOrder;
  }

  /**
   * Compatibility wrapper for older code paths that still pass nonce/deadline inside the order.
   * New trading example requests should use verifySignedTradingOrder(order, intent, signature).
   */
  async verifySignedOrder(
    order: SignedOrderPayload,
    signature: Hex,
  ): Promise<OrderRequest> {
    const normalizedOrder = normalizeTradingOrder(order);
    const intent = buildTradingOrderIntent({
      order: normalizedOrder,
      nonce: order.nonce,
      deadline: order.deadline,
    });
    return this.verifySignedTradingOrder(normalizedOrder, intent, signature);
  }

  private async resolveVerifyingContract(): Promise<Address> {
    try {
      const contracts = await loadContractsConfig(this.appConfig.contractsFile);
      if (
        hasUsableVaultDeployment(contracts) &&
        contracts.collateralVault.address
      ) {
        return getAddress(contracts.collateralVault.address);
      }
    } catch {
      // Unit/API tests can run without a deployed Vault. In that case signatures bind to zeroAddress.
    }

    return zeroAddress;
  }
}

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

export function buildTradingOrderIntent(args: {
  order: OrderRequest;
  nonce: string;
  deadline: number;
  appId?: string;
}): SignedIntent {
  const order = normalizeTradingOrder(args.order);
  return {
    userAddress: order.userAddress,
    appId: args.appId ?? "trading-example",
    intentType: "TRADING_ORDER",
    payloadHash: hashTradingOrderPayload(order),
    nonce: args.nonce,
    deadline: args.deadline,
  };
}

export function buildWithdrawalRequestIntent(args: {
  userAddress: HexAddress;
  amount: number | string;
  chainId: number;
  vaultAddress: Address;
  nonce: string;
  deadline: number;
  appId?: string;
}): SignedIntent {
  return {
    userAddress: getAddress(args.userAddress) as HexAddress,
    appId: args.appId ?? COLLATERAL_GATEWAY_APP_ID,
    intentType: WITHDRAWAL_REQUEST_INTENT_TYPE,
    payloadHash: hashWithdrawalRequestPayload(args),
    nonce: args.nonce,
    deadline: args.deadline,
  };
}

export function hashWithdrawalRequestPayload(args: {
  userAddress: HexAddress;
  amount: number | string;
  chainId: number;
  vaultAddress: Address;
}): Hex {
  const canonicalPayload = JSON.stringify({
    userAddress: getAddress(args.userAddress),
    amount: normalizePositiveDecimalForPayload(
      args.amount,
      "withdrawal amount",
    ),
    chainId: args.chainId,
    vaultAddress: getAddress(args.vaultAddress),
  });
  return keccak256(toHex(canonicalPayload));
}

export function hashTradingOrderPayload(order: OrderRequest): Hex {
  const normalized = normalizeTradingOrder(order);
  const canonicalPayload = JSON.stringify({
    userAddress: getAddress(normalized.userAddress),
    symbol: normalized.symbol,
    side: normalized.side,
    type: "MARKET",
    quantity: normalizeQuantityForPayload(normalized.quantity),
    clientOrderId: normalized.clientOrderId,
  });
  return keccak256(toHex(canonicalPayload));
}

export function normalizeSignedIntent(intent: SignedIntent): SignedIntent {
  if (!/^0x[a-fA-F0-9]{64}$/.test(intent.payloadHash)) {
    throw conflict(
      "INVALID_INTENT_PAYLOAD_HASH",
      "Signed intent payloadHash must be bytes32",
    );
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

function normalizeTradingOrder(order: OrderRequest): OrderRequest {
  return {
    userAddress: getAddress(order.userAddress) as HexAddress,
    symbol: order.symbol.toUpperCase(),
    side: order.side,
    type: "MARKET",
    quantity: order.quantity,
    clientOrderId: order.clientOrderId,
  };
}

function normalizePositiveDecimalForPayload(
  value: number | string,
  label: string,
): string {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw conflict(
      "INVALID_SIGNED_INTENT_AMOUNT",
      `${label} must be a positive finite number`,
    );
  }
  return numeric.toString();
}

function normalizeQuantityForPayload(quantity: number): string {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw conflict("INVALID_QUANTITY", "Order quantity must be positive");
  }

  return quantity.toString();
}

export { SignedIntentService as OrderSignatureService };
