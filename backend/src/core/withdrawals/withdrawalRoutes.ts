import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import type { WebSocketHub } from "../websocket/websocketHub.js";
import type { WithdrawalService } from "./withdrawalService.js";
import { requireAdminAuth } from "../auth/adminAuth.js";
import {
  userAddressParamsSchema,
  withdrawalApprovalSchema,
  withdrawalRequestSchema,
} from "../../utils/validation.js";
import {
  addressParamSchema,
  errorResponses,
  portfolioSchema,
  withdrawalRequestOpenApiSchema,
  withdrawalSchema,
} from "../../docs/openapiSchemas.js";

const withdrawalApprovalBodySchema = {
  type: "object",
  required: ["amount"],
  properties: {
    amount: { type: "number", exclusiveMinimum: 0, example: 100 },
  },
};

const withdrawalResultSchema = {
  type: "object",
  required: ["withdrawal", "portfolio"],
  properties: {
    withdrawal: withdrawalSchema,
    portfolio: portfolioSchema,
  },
};

export async function withdrawalRoutes(
  app: FastifyInstance,
  withdrawalService: WithdrawalService,
  wsHub: WebSocketHub,
  appConfig: AppConfig,
): Promise<void> {
  const requireAdmin = requireAdminAuth(appConfig);
  app.post(
    "/withdrawals/request",
    {
      schema: {
        tags: ["Withdrawals"],
        summary: "Request withdrawal approval with a user-signed intent",
        description:
          "Creates an on-chain withdrawal request only after validating a verified user-signed WITHDRAWAL_REQUEST intent. Actual token withdrawal still requires operator approval and withdrawApproved on the contract.",
        body: withdrawalRequestOpenApiSchema,
        response: {
          200: {
            description: "Withdrawal requested",
            ...withdrawalResultSchema,
          },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const body = withdrawalRequestSchema.parse(request.body);
      const result = await withdrawalService.requestWithdrawal(
        body.userAddress,
        body.amount,
        body.signedIntentId,
      );

      wsHub.publish({
        type: "withdrawal:requested",
        payload: result.withdrawal,
      });
      wsHub.publish({ type: "portfolio:updated", payload: result.portfolio });

      return result;
    },
  );

  app.post(
    "/withdrawals/approve/:userAddress",
    {
      preHandler: requireAdmin,
      schema: {
        tags: ["Withdrawals"],
        summary: "Approve pending withdrawal after risk checks",
        description:
          "Approves a requested withdrawal only when there is no open position, no pending realized P&L and enough collateral.",
        params: addressParamSchema("userAddress"),
        body: withdrawalApprovalBodySchema,
        security: [{ AdminBearerAuth: [] }],
        response: {
          200: {
            description: "Withdrawal approved",
            ...withdrawalResultSchema,
          },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { userAddress } = userAddressParamsSchema.parse(request.params);
      const body = withdrawalApprovalSchema.parse(request.body);
      const result = await withdrawalService.approveWithdrawal(
        userAddress,
        body.amount,
      );

      wsHub.publish({
        type: "withdrawal:approved",
        payload: result.withdrawal,
      });
      wsHub.publish({ type: "portfolio:updated", payload: result.portfolio });

      return result;
    },
  );
}
