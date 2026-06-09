import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import type { WebSocketHub } from "../websocket/websocketHub.js";
import type { SettlementService } from "./settlementService.js";
import { authorizeSettlementRequest } from "../auth/appRegistry.js";
import { hexSchema, settlementRequestSchema } from "../../utils/validation.js";
import {
  errorResponses,
  portfolioSchema,
  settlementReportSchema,
  settlementRequestOpenApiSchema,
  settlementSchema,
} from "../../docs/openapiSchemas.js";

const settlementIdParamSchema = {
  type: "object",
  required: ["settlementId"],
  properties: {
    settlementId: { type: "string", example: "0x".padEnd(66, "a") },
  },
};

const settlementResultSchema = {
  type: "object",
  required: ["settlement", "portfolio"],
  properties: {
    settlement: settlementSchema,
    portfolio: portfolioSchema,
  },
};

export async function settlementRoutes(
  app: FastifyInstance,
  settlementService: SettlementService,
  wsHub: WebSocketHub,
  appConfig: AppConfig,
): Promise<void> {
  app.post(
    "/settlements",
    {
      schema: {
        tags: ["Settlements"],
        summary: "Apply a generic off-chain settlement on-chain",
        description:
          "Operator flow that applies a generic amountDelta to CollateralVault with settlementId and reasonHash audit data. Trading P&L is one settlementType: TRADING_PNL.",
        body: settlementRequestOpenApiSchema,
        security: [{ AdminBearerAuth: [] }, { AppAuthHeaders: [] }],
        response: {
          200: {
            description: "Settlement submitted and confirmed",
            ...settlementResultSchema,
          },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const body = settlementRequestSchema.parse(request.body);
      const authContext = authorizeSettlementRequest(request, appConfig, body);
      const result = await settlementService.submitSettlement(
        body,
        (settlement, portfolio) => {
          wsHub.publish({ type: "settlement:submitted", payload: settlement });
          wsHub.publish({ type: "portfolio:updated", payload: portfolio });
        },
        authContext,
      );

      wsHub.publish({
        type: "settlement:confirmed",
        payload: result.settlement,
      });
      wsHub.publish({ type: "portfolio:updated", payload: result.portfolio });

      return result;
    },
  );

  app.get(
    "/settlements/:settlementId",
    {
      schema: {
        tags: ["Settlements"],
        summary: "Get settlement record by id",
        description:
          "Returns the stored generic settlement record, including appId, settlementType, amountDelta, reasonHash, referenceIds, metadata, on-chain transaction status and timestamps.",
        params: settlementIdParamSchema,
        response: {
          200: { description: "Settlement record", ...settlementSchema },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { settlementId } = request.params as { settlementId: unknown };
      return settlementService.getSettlement(hexSchema.parse(settlementId));
    },
  );

  app.get(
    "/settlements/:settlementId/report",
    {
      schema: {
        tags: ["Settlements"],
        summary: "Get settlement audit report",
        description:
          "Returns a self-contained audit report linking the generic settlement request, off-chain calculation references, verified signed intents, reasonHash and on-chain SettlementApplied transaction/event metadata. Trading settlements include an additional trading summary.",
        params: settlementIdParamSchema,
        response: {
          200: {
            description: "Settlement audit report",
            ...settlementReportSchema,
          },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { settlementId } = request.params as { settlementId: unknown };
      return settlementService.getSettlementReport(
        hexSchema.parse(settlementId),
      );
    },
  );
}
