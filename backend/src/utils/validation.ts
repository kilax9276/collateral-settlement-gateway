import { z } from "zod";

export const addressSchema = z.custom<`0x${string}`>(
  (value) => typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value),
  "Invalid EVM address",
);

export const hexSchema = z.custom<`0x${string}`>(
  (value) => typeof value === "string" && /^0x[a-fA-F0-9]+$/.test(value),
  "Invalid hex string",
);

export const bytes32Schema = z.custom<`0x${string}`>(
  (value) => typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value),
  "Invalid bytes32 hex string",
);

export const signedIntentSchema = z.object({
  userAddress: addressSchema,
  appId: z.string().min(1),
  intentType: z.string().min(1),
  payloadHash: bytes32Schema,
  nonce: z.string().min(8),
  deadline: z.number().int().positive(),
});

export const signedIntentRequestSchema = z.object({
  intent: signedIntentSchema,
  signature: hexSchema,
});

export const userAddressParamsSchema = z.object({
  userAddress: addressSchema,
});

export const nonceAddressParamsSchema = z.object({
  address: addressSchema,
});

export const symbolParamsSchema = z.object({
  symbol: z
    .string()
    .min(1)
    .transform((value) => value.toUpperCase()),
});

export const orderSchema = z.object({
  userAddress: addressSchema,
  symbol: z
    .string()
    .min(1)
    .transform((value) => value.toUpperCase()),
  side: z.enum(["BUY", "SELL"]),
  type: z.literal("MARKET").default("MARKET"),
  quantity: z.number().positive(),
  clientOrderId: z.string().min(1),
});

export const signedTradingOrderSchema = z.object({
  order: orderSchema,
  intent: signedIntentSchema,
  signature: hexSchema,
});

export const signedOrderSchema = z.object({
  order: z.object({
    userAddress: addressSchema,
    symbol: z
      .string()
      .min(1)
      .transform((value) => value.toUpperCase()),
    side: z.enum(["BUY", "SELL"]),
    type: z.literal("MARKET").default("MARKET"),
    quantity: z.number().positive(),
    clientOrderId: z.string().min(1),
    nonce: z.string().min(8),
    deadline: z.number().int().positive(),
  }),
  signature: hexSchema,
});

export const manualPriceSchema = z.object({
  price: z.number().positive(),
  timestamp: z.string().datetime().optional(),
});

export const seedDepositSchema = z.object({
  userAddress: addressSchema,
  amount: z.number().positive(),
});

const amountDeltaStringSchema = z
  .string()
  .regex(
    /^[+-]?(?:0|[1-9]\d*)(?:\.\d{1,8})?$/,
    "Invalid settlement amount delta",
  );

export const settlementRequestSchema = z.object({
  userAddress: addressSchema,
  appId: z
    .string()
    .min(1)
    .transform((value) => value.trim()),
  settlementType: z
    .string()
    .min(1)
    .transform((value) => value.trim().toUpperCase()),
  amountDelta: amountDeltaStringSchema,
  reasonHash: bytes32Schema,
  referenceIds: z.array(z.string().min(1)).default([]),
  signedIntentIds: z.array(z.string().min(1)).default([]),
  metadata: z.record(z.unknown()).optional(),
});

export const withdrawalRequestSchema = z.object({
  userAddress: addressSchema,
  amount: z.number().positive(),
  signedIntentId: z.string().min(1),
});

export const withdrawalApprovalSchema = z.object({
  amount: z.number().positive(),
});
