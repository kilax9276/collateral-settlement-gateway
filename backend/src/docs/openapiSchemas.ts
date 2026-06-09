const addressPattern = "^0x[a-fA-F0-9]{40}$";
const hexPattern = "^0x[a-fA-F0-9]+$";

export const addressParamSchema = (name: "address" | "userAddress") => ({
  type: "object",
  required: [name],
  properties: {
    [name]: {
      type: "string",
      pattern: addressPattern,
      example: "0x0000000000000000000000000000000000000001",
    },
  },
});

export const symbolParamSchema = {
  type: "object",
  required: ["symbol"],
  properties: {
    symbol: { type: "string", example: "BTC-USD" },
  },
};

export const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string", example: "VALIDATION_ERROR" },
        message: { type: "string", example: "Invalid request" },
        details: {
          description:
            "Optional machine-readable validation issues, policy context or diagnostic data.",
          oneOf: [
            { type: "object", additionalProperties: true },
            {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
            { type: "string" },
            { type: "number" },
            { type: "boolean" },
          ],
        },
      },
    },
  },
};

export const errorResponses = {
  400: {
    description: "Validation error example",
    ...errorResponseSchema,
    example: {
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request",
        details: [
          {
            path: ["body", "amount"],
            message: "Number must be greater than 0",
          },
        ],
      },
    },
  },

  401: {
    description: "Authentication error example",
    ...errorResponseSchema,
    example: {
      error: {
        code: "ADMIN_AUTH_REQUIRED",
        message: "Missing or invalid admin bearer token",
      },
    },
  },
  403: {
    description: "Authorization policy rejection example",
    ...errorResponseSchema,
    example: {
      error: {
        code: "APP_ID_MISMATCH",
        message: "Settlement appId must match X-App-Id header",
      },
    },
  },
  404: {
    description: "Resource not found example",
    ...errorResponseSchema,
    example: {
      error: {
        code: "SYMBOL_NOT_FOUND",
        message: "Unknown symbol: ETH-USD",
      },
    },
  },
  409: {
    description: "Business-rule rejection example",
    ...errorResponseSchema,
    example: {
      error: {
        code: "INSUFFICIENT_COLLATERAL",
        message: "Insufficient free collateral after order",
      },
    },
  },
  500: {
    description: "Unexpected internal error example",
    ...errorResponseSchema,
    example: {
      error: { code: "INTERNAL_ERROR", message: "Unexpected error" },
    },
  },
};

export const quoteSchema = {
  type: "object",
  required: ["symbol", "price", "source", "timestamp", "ts"],
  properties: {
    symbol: { type: "string", example: "BTC-USD" },
    price: { type: "number", example: 65000 },
    source: { type: "string", example: "mock" },
    timestamp: { type: "string", format: "date-time" },
    ts: { type: "string", format: "date-time" },
    confidence: { type: "number", example: 0.99 },
    confidenceInterval: { type: "number", example: 25 },
    raw: { type: "object", additionalProperties: true },
  },
};

export const positionSchema = {
  type: "object",
  required: [
    "symbol",
    "quantity",
    "avgEntryPrice",
    "realizedPnl",
    "unrealizedPnl",
    "markPrice",
  ],
  properties: {
    symbol: { type: "string", example: "BTC-USD" },
    quantity: { type: "number", example: 0.05 },
    avgEntryPrice: { type: "number", example: 65000 },
    realizedPnl: { type: "number", example: 100 },
    unrealizedPnl: { type: "number", example: 0 },
    markPrice: { type: "number", example: 67000 },
  },
};

export const orderSchema = {
  type: "object",
  required: [
    "orderId",
    "clientOrderId",
    "userAddress",
    "symbol",
    "side",
    "type",
    "quantity",
    "status",
    "createdAt",
  ],
  properties: {
    orderId: { type: "string", example: "ord_abc123" },
    clientOrderId: { type: "string", example: "buy-1" },
    userAddress: { type: "string", pattern: addressPattern },
    symbol: { type: "string", example: "BTC-USD" },
    side: { type: "string", enum: ["BUY", "SELL"] },
    type: { type: "string", enum: ["MARKET"] },
    quantity: { type: "number", example: 0.05 },
    status: { type: "string", enum: ["FILLED"] },
    createdAt: { type: "string", format: "date-time" },
  },
};

export const tradeSchema = {
  type: "object",
  required: [
    "tradeId",
    "orderId",
    "clientOrderId",
    "userAddress",
    "symbol",
    "side",
    "quantity",
    "price",
    "notional",
    "fee",
    "realizedPnlDelta",
    "latencyMs",
    "ts",
  ],
  properties: {
    tradeId: { type: "string", example: "trd_abc123" },
    orderId: { type: "string", example: "ord_abc123" },
    clientOrderId: { type: "string", example: "buy-1" },
    userAddress: { type: "string", pattern: addressPattern },
    symbol: { type: "string", example: "BTC-USD" },
    side: { type: "string", enum: ["BUY", "SELL"] },
    quantity: { type: "number", example: 0.05 },
    price: { type: "number", example: 65000 },
    notional: { type: "number", example: 3250 },
    fee: { type: "number", example: 1.625 },
    realizedPnlDelta: { type: "number", example: 0 },
    latencyMs: { type: "number", example: 2.5 },
    ts: { type: "string", format: "date-time" },
  },
};

export const settlementRequestOpenApiSchema = {
  type: "object",
  example: {
    userAddress: "0x0000000000000000000000000000000000000001",
    appId: "fantasy-trading-app",
    settlementType: "EXTERNAL_APP_REWARD",
    amountDelta: "25",
    reasonHash:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    referenceIds: ["fantasy-round-001"],
    signedIntentIds: ["intent_abc123"],
    metadata: { source: "external-client-example" },
  },
  required: [
    "userAddress",
    "appId",
    "settlementType",
    "amountDelta",
    "reasonHash",
    "referenceIds",
  ],
  properties: {
    userAddress: {
      type: "string",
      pattern: addressPattern,
      description: "Gateway user whose Vault balance will be adjusted.",
    },
    appId: {
      type: "string",
      example: "trading-example",
      description:
        "External application or example module requesting settlement.",
    },
    settlementType: {
      type: "string",
      example: "TRADING_PNL",
      description:
        "Application-defined reason category such as TRADING_PNL, EXTERNAL_APP_REWARD or GAME_REWARD.",
    },
    amountDelta: {
      type: "string",
      example: "96.7",
      description:
        "Signed decimal amount. Positive increases the user Vault balance; negative decreases it.",
    },
    reasonHash: {
      type: "string",
      pattern: "^0x[a-fA-F0-9]{64}$",
      example:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      description:
        "Hash committing to the off-chain calculation context for auditability.",
    },
    referenceIds: {
      type: "array",
      items: { type: "string" },
      example: ["trd_abc123"],
      description:
        "Application reference ids such as trade ids, game round ids, prediction ids or reward calculation ids.",
    },
    signedIntentIds: {
      type: "array",
      items: { type: "string" },
      example: ["intent_abc123"],
      description:
        "Verified SignedIntent ids that authorize or support this settlement. Required for app-authenticated settlements.",
    },
    metadata: {
      type: "object",
      additionalProperties: true,
      description:
        "Optional JSON audit context stored off-chain and returned in settlement reports.",
    },
  },
};

export const settlementSchema = {
  type: "object",
  example: {
    settlementId:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    reasonHash:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    userAddress: "0x0000000000000000000000000000000000000001",
    appId: "fantasy-trading-app",
    settlementType: "EXTERNAL_APP_REWARD",
    amountDelta: 25,
    pnl: 25,
    referenceIds: ["fantasy-round-001"],
    signedIntentIds: ["intent_abc123"],
    status: "ONCHAIN_SUBMITTED",
    txHash: "0xabc123",
    ts: "2026-06-09T00:00:00.000Z",
  },
  required: [
    "settlementId",
    "reasonHash",
    "userAddress",
    "appId",
    "settlementType",
    "amountDelta",
    "pnl",
    "referenceIds",
    "signedIntentIds",
    "status",
    "txHash",
    "ts",
  ],
  properties: {
    settlementId: { type: "string", pattern: hexPattern },
    reasonHash: {
      type: "string",
      pattern: hexPattern,
      description:
        "Hash linking the on-chain settlement to off-chain calculation context.",
    },
    userAddress: { type: "string", pattern: addressPattern },
    appId: { type: "string", example: "trading-example" },
    settlementType: { type: "string", example: "TRADING_PNL" },
    amountDelta: {
      type: "number",
      example: 96.7,
      description:
        "Applied balance delta. Positive credits the user; negative debits the user.",
    },
    pnl: {
      type: "number",
      example: 96.7,
      description:
        "Deprecated alias for amountDelta kept for legacy trading compatibility.",
    },
    referenceIds: {
      type: "array",
      items: { type: "string" },
      example: ["trd_abc123"],
    },
    signedIntentIds: {
      type: "array",
      items: { type: "string" },
      example: ["intent_abc123"],
    },
    metadata: { type: "object", additionalProperties: true },
    status: {
      type: "string",
      enum: ["ONCHAIN_SUBMITTED", "ONCHAIN_CONFIRMED"],
    },
    txHash: { type: "string", example: "0xabc123" },
    createdAt: { type: "string", format: "date-time" },
    confirmedAt: { type: ["string", "null"], format: "date-time" },
    blockNumber: { type: ["string", "null"], example: "42" },
    eventName: { type: ["string", "null"], example: "SettlementApplied" },
    contractAddress: { type: ["string", "null"], pattern: addressPattern },
    ts: { type: "string", format: "date-time" },
  },
};

export const withdrawalSchema = {
  type: "object",
  example: {
    withdrawalId: "withdraw_0xabc",
    userAddress: "0x0000000000000000000000000000000000000001",
    amount: 100,
    status: "ONCHAIN_REQUESTED",
    txHash: "0xabc123",
    ts: "2026-06-09T00:00:00.000Z",
  },
  required: ["withdrawalId", "userAddress", "amount", "status", "txHash", "ts"],
  properties: {
    withdrawalId: { type: "string", example: "withdraw_0xabc" },
    userAddress: { type: "string", pattern: addressPattern },
    amount: { type: "number", example: 100 },
    status: { type: "string", enum: ["ONCHAIN_REQUESTED", "ONCHAIN_APPROVED"] },
    txHash: { type: "string", example: "0xabc123" },
    ts: { type: "string", format: "date-time" },
  },
};

export const portfolioSchema = {
  type: "object",
  required: [
    "userAddress",
    "collateral",
    "equity",
    "marginUsed",
    "freeCollateral",
    "pendingSettlementPnl",
    "pendingWithdrawals",
    "approvedWithdrawals",
    "positions",
    "orders",
    "trades",
    "settlements",
    "ts",
  ],
  properties: {
    userAddress: { type: "string", pattern: addressPattern },
    collateral: { type: "number", example: 10000 },
    equity: { type: "number", example: 10096.7 },
    marginUsed: { type: "number", example: 0 },
    freeCollateral: { type: "number", example: 10096.7 },
    pendingSettlementPnl: { type: "number", example: 0 },
    pendingWithdrawals: { type: "number", example: 0 },
    approvedWithdrawals: { type: "number", example: 0 },
    positions: { type: "array", items: positionSchema },
    orders: { type: "array", items: orderSchema },
    trades: { type: "array", items: tradeSchema },
    settlements: { type: "array", items: settlementSchema },
    ts: { type: "string", format: "date-time" },
  },
};

export const orderResultSchema = {
  type: "object",
  required: ["order", "trade", "portfolio"],
  properties: {
    order: orderSchema,
    trade: tradeSchema,
    portfolio: portfolioSchema,
  },
};

export const signedIntentSchema = {
  type: "object",
  example: {
    userAddress: "0x0000000000000000000000000000000000000001",
    appId: "fantasy-trading-app",
    intentType: "EXTERNAL_APP_REWARD",
    payloadHash:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    nonce: "intentnonce_abc123",
    deadline: 1790000000,
  },
  required: [
    "userAddress",
    "appId",
    "intentType",
    "payloadHash",
    "nonce",
    "deadline",
  ],
  properties: {
    userAddress: {
      type: "string",
      pattern: addressPattern,
      description: "Wallet address expected to sign the intent.",
    },
    appId: {
      type: "string",
      example: "trading-example",
      description: "Application namespace for the signed off-chain action.",
    },
    intentType: {
      type: "string",
      example: "TRADING_ORDER",
      description:
        "Application-defined action type such as TRADING_ORDER, GAME_ACTION or REWARD_CLAIM.",
    },
    payloadHash: {
      type: "string",
      pattern: "^0x[a-fA-F0-9]{64}$",
      example:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    },
    nonce: {
      type: "string",
      example: "intentnonce_abc123",
      description:
        "One-time nonce issued by GET /auth/nonce/:address and consumed after verification.",
    },
    deadline: {
      type: "integer",
      example: 1790000000,
      description: "Unix timestamp after which the intent is rejected.",
    },
  },
};

export const signedIntentRequestSchema = {
  type: "object",
  required: ["intent", "signature"],
  properties: {
    intent: signedIntentSchema,
    signature: { type: "string", pattern: hexPattern, example: "0xabcdef" },
  },
};

export const signedIntentVerificationSchema = {
  type: "object",
  required: [
    "valid",
    "signer",
    "intent",
    "intentId",
    "status",
    "nonceConsumed",
  ],
  properties: {
    valid: { type: "boolean", example: true },
    signer: { type: "string", pattern: addressPattern },
    intent: signedIntentSchema,
    intentId: { type: "string", example: "intent_abc123" },
    status: { type: "string", enum: ["VERIFIED"] },
    nonceConsumed: { type: "boolean", example: true },
  },
};

export const tradingOrderRequestSchema = {
  type: "object",
  required: [
    "userAddress",
    "symbol",
    "side",
    "type",
    "quantity",
    "clientOrderId",
  ],
  properties: {
    userAddress: { type: "string", pattern: addressPattern },
    symbol: { type: "string", example: "BTC-USD" },
    side: { type: "string", enum: ["BUY", "SELL"] },
    type: { type: "string", enum: ["MARKET"] },
    quantity: { type: "number", exclusiveMinimum: 0, example: 0.05 },
    clientOrderId: { type: "string", example: "buy-1" },
  },
};

export const signedTradingOrderRequestSchema = {
  type: "object",
  required: ["order", "intent", "signature"],
  properties: {
    order: tradingOrderRequestSchema,
    intent: signedIntentSchema,
    signature: { type: "string", pattern: hexPattern, example: "0xabcdef" },
  },
};

export const signedOrderRequestSchema = signedTradingOrderRequestSchema;

export const reconciliationReportSchema = {
  type: "object",
  example: {
    userAddress: "0x0000000000000000000000000000000000000001",
    onChainBalance: 10000,
    offChainBalance: 10000,
    pendingRealizedPnl: 0,
    openPosition: false,
    openPositions: [],
    pendingWithdraw: 0,
    onChainPendingWithdraw: 0,
    offChainPendingWithdraw: 0,
    settlementHistory: [],
    status: "OK",
    detectedIssues: [],
    ts: "2026-06-09T00:00:00.000Z",
  },
  required: [
    "userAddress",
    "onChainBalance",
    "offChainBalance",
    "pendingRealizedPnl",
    "openPosition",
    "openPositions",
    "pendingWithdraw",
    "onChainPendingWithdraw",
    "offChainPendingWithdraw",
    "settlementHistory",
    "status",
    "detectedIssues",
    "ts",
  ],
  properties: {
    userAddress: { type: "string", pattern: addressPattern },
    onChainBalance: { type: ["number", "null"], example: 10000 },
    offChainBalance: { type: "number", example: 10000 },
    pendingRealizedPnl: { type: "number", example: 0 },
    openPosition: { type: "boolean", example: false },
    openPositions: { type: "array", items: positionSchema },
    pendingWithdraw: { type: "number", example: 0 },
    onChainPendingWithdraw: { type: ["number", "null"], example: 0 },
    offChainPendingWithdraw: { type: "number", example: 0 },
    settlementHistory: { type: "array", items: settlementSchema },
    status: { type: "string", enum: ["OK", "WARNING", "MISMATCH"] },
    detectedIssues: { type: "array", items: { type: "string" } },
    ts: { type: "string", format: "date-time" },
  },
};

export const withdrawalRequestOpenApiSchema = {
  type: "object",
  required: ["userAddress", "amount", "signedIntentId"],
  example: {
    userAddress: "0x0000000000000000000000000000000000000001",
    amount: 100,
    signedIntentId: "intent_withdrawal_abc123",
  },
  properties: {
    userAddress: { type: "string", pattern: addressPattern },
    amount: { type: "number", exclusiveMinimum: 0, example: 100 },
    signedIntentId: {
      type: "string",
      example: "intent_withdrawal_abc123",
      description:
        "Verified WITHDRAWAL_REQUEST SignedIntent id authorizing this withdrawal request.",
    },
  },
};

export const settlementReportSchema = {
  type: "object",
  required: [
    "settlementId",
    "userAddress",
    "appId",
    "settlementType",
    "amountDelta",
    "accounting",
    "reasonHash",
    "referenceIds",
    "offChainCalculation",
    "signedIntentIds",
    "linkedSignedIntents",
    "audit",
    "onChain",
    "status",
    "createdAt",
    "confirmedAt",
  ],
  example: {
    settlementId:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    userAddress: "0x0000000000000000000000000000000000000001",
    appId: "fantasy-trading-app",
    settlementType: "EXTERNAL_APP_REWARD",
    amountDelta: 25,
    accounting: {
      amountDeltaMicroUsdc: "25000000",
      formattedAmountDelta: "25",
      storageModel: "DECIMAL_API_WITH_INTEGER_CONTRACT_UNITS",
    },
    reasonHash:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    referenceIds: ["fantasy-round-001"],
    offChainCalculation: { metadataHash: "0xabc" },
    signedIntentIds: ["intent_abc123"],
    linkedSignedIntents: [
      {
        id: "intent_abc123",
        appId: "fantasy-trading-app",
        intentType: "EXTERNAL_APP_REWARD",
        payloadHash:
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        nonce: "intentnonce_abc123",
        signer: "0x0000000000000000000000000000000000000001",
        userAddress: "0x0000000000000000000000000000000000000001",
        deadline: 1790000000,
        status: "CONSUMED",
        createdAt: "2026-06-09T00:00:00.000Z",
        consumedAt: "2026-06-09T00:01:00.000Z",
        consumedBySettlementId:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
      },
    ],
    audit: {
      authorization: "app-authenticated",
      trustedOperatorSettlement: false,
      warnings: [],
    },
    onChain: {
      txHash: "0xabc123",
      blockNumber: "42",
      eventName: "SettlementApplied",
      contractAddress: "0x0000000000000000000000000000000000000002",
    },
    status: "ONCHAIN_SUBMITTED",
    createdAt: "2026-06-09T00:00:00.000Z",
    confirmedAt: null,
  },
  properties: {
    settlementId: { type: "string", pattern: hexPattern },
    userAddress: { type: "string", pattern: addressPattern },
    appId: { type: "string", example: "fantasy-trading-app" },
    settlementType: { type: "string", example: "EXTERNAL_APP_REWARD" },
    amountDelta: { type: "number", example: 25 },
    accounting: {
      type: "object",
      required: [
        "amountDeltaMicroUsdc",
        "formattedAmountDelta",
        "storageModel",
      ],
      properties: {
        amountDeltaMicroUsdc: {
          type: "string",
          example: "25000000",
          description:
            "Signed token-native microUSDC units used for the on-chain Vault settlement call.",
        },
        formattedAmountDelta: { type: "string", example: "25" },
        storageModel: {
          type: "string",
          example: "DECIMAL_API_WITH_INTEGER_CONTRACT_UNITS",
        },
      },
    },
    reasonHash: { type: "string", pattern: hexPattern },
    referenceIds: {
      type: "array",
      items: { type: "string" },
      example: ["fantasy-round-001"],
    },
    metadata: { type: "object", additionalProperties: true },
    offChainCalculation: { type: "object", additionalProperties: true },
    signedIntentIds: {
      type: "array",
      items: { type: "string" },
      example: ["intent_abc123"],
    },
    linkedSignedIntents: {
      type: "array",
      items: {
        type: "object",
        required: [
          "id",
          "appId",
          "intentType",
          "payloadHash",
          "nonce",
          "signer",
          "userAddress",
          "deadline",
          "status",
          "createdAt",
        ],
        properties: {
          id: { type: "string" },
          appId: { type: "string" },
          intentType: { type: "string" },
          payloadHash: { type: "string", pattern: hexPattern },
          nonce: { type: "string" },
          signer: { type: "string", pattern: addressPattern },
          userAddress: { type: "string", pattern: addressPattern },
          deadline: { type: "number" },
          status: { type: "string", enum: ["VERIFIED", "CONSUMED", "EXPIRED"] },
          createdAt: { type: "string", format: "date-time" },
          consumedAt: { type: ["string", "null"], format: "date-time" },
          consumedBySettlementId: { type: ["string", "null"] },
        },
      },
    },
    audit: {
      type: "object",
      required: ["authorization", "trustedOperatorSettlement", "warnings"],
      properties: {
        authorization: { type: "string" },
        trustedOperatorSettlement: { type: "boolean" },
        warnings: { type: "array", items: { type: "string" } },
      },
    },
    onChain: {
      type: "object",
      required: ["txHash", "blockNumber", "eventName", "contractAddress"],
      properties: {
        txHash: { type: "string" },
        blockNumber: { type: ["string", "null"] },
        eventName: { type: "string" },
        contractAddress: { type: ["string", "null"], pattern: addressPattern },
      },
    },
    status: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    confirmedAt: { type: ["string", "null"], format: "date-time" },
    trading: { type: "object", additionalProperties: true },
  },
};

export const gatewayMetricsSchema = {
  type: "object",
  required: [
    "chainId",
    "vaultAddress",
    "operatorAddress",
    "indexer",
    "storage",
    "collateral",
    "operations",
    "tradingExample",
  ],
  example: {
    chainId: 31337,
    vaultAddress: "0x0000000000000000000000000000000000000001",
    operatorAddress: "0x0000000000000000000000000000000000000002",
    indexer: {
      enabled: true,
      status: "running",
      lastProcessedBlock: "42",
      lagBlocks: 0,
    },
    storage: { driver: "sqlite", status: "OK", path: "backend/data/app.db" },
    collateral: {
      totalUsers: 1,
      totalUserCollateral: 10000,
      totalLiabilities: 10000,
      insuranceBalance: 5000,
    },
    operations: {
      pendingWithdrawals: 0,
      pendingSettlements: 0,
      recentSettlements: 3,
      recentSignedIntents: 5,
    },
    tradingExample: {
      openPositions: 0,
      supportedSymbols: ["BTC-USD"],
    },
    reconciliationSummary: { OK: 1, WARNING: 0, MISMATCH: 0 },
  },
  properties: {
    chainId: { type: "number", example: 31337 },
    vaultAddress: { type: ["string", "null"], pattern: addressPattern },
    operatorAddress: { type: ["string", "null"], pattern: addressPattern },
    indexer: {
      type: "object",
      required: ["enabled", "status", "lastProcessedBlock", "lagBlocks"],
      properties: {
        enabled: { type: "boolean" },
        status: { type: "string", enum: ["running", "stopped", "disabled"] },
        lastProcessedBlock: { type: ["string", "null"], example: "42" },
        lagBlocks: { type: ["number", "null"], example: 0 },
      },
    },
    storage: {
      type: "object",
      required: ["driver", "status"],
      properties: {
        driver: { type: "string", enum: ["memory", "sqlite"] },
        status: { type: "string", enum: ["OK", "UNAVAILABLE"] },
        path: { type: "string", example: "backend/data/app.db" },
      },
    },
    collateral: {
      type: "object",
      required: [
        "totalUsers",
        "totalUserCollateral",
        "totalLiabilities",
        "insuranceBalance",
      ],
      properties: {
        totalUsers: { type: "number", example: 1 },
        totalUserCollateral: { type: "number", example: 10000 },
        totalLiabilities: { type: ["number", "null"], example: 10000 },
        insuranceBalance: { type: ["number", "null"], example: 5000 },
      },
    },
    operations: {
      type: "object",
      required: [
        "pendingWithdrawals",
        "pendingSettlements",
        "recentSettlements",
        "recentSignedIntents",
      ],
      properties: {
        pendingWithdrawals: { type: "number", example: 0 },
        pendingSettlements: { type: "number", example: 0 },
        recentSettlements: { type: "number", example: 3 },
        recentSignedIntents: { type: "number", example: 5 },
      },
    },
    tradingExample: {
      type: "object",
      required: ["openPositions", "supportedSymbols"],
      properties: {
        openPositions: { type: "number", example: 0 },
        supportedSymbols: {
          type: "array",
          items: { type: "string" },
          example: ["BTC-USD"],
        },
      },
    },
    reconciliationSummary: {
      type: "object",
      additionalProperties: { type: "number" },
    },
    ts: { type: "string", format: "date-time" },
  },
};

export const systemHealthSchema = {
  type: "object",
  required: ["chainId", "vaultAddress", "indexer", "sqlite", "ts"],
  properties: {
    chainId: { type: "number", example: 31337 },
    vaultAddress: { type: ["string", "null"], pattern: addressPattern },
    indexer: {
      type: "object",
      required: ["enabled", "started", "lastProcessedBlock"],
      properties: {
        enabled: { type: "boolean", example: true },
        started: { type: "boolean", example: true },
        lastProcessedBlock: { type: ["string", "null"], example: "42" },
      },
    },
    sqlite: {
      type: "object",
      required: ["driver", "status"],
      properties: {
        driver: { type: "string", enum: ["memory", "sqlite"] },
        status: { type: "string", enum: ["OK", "UNAVAILABLE"] },
        path: { type: "string", example: "backend/data/app.db" },
      },
    },
    ts: { type: "string", format: "date-time" },
  },
};
