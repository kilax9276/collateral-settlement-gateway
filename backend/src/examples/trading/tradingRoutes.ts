import type { FastifyInstance } from "fastify";
import type { WebSocketHub } from "../../core/websocket/websocketHub.js";
import type { SignedIntentService } from "../../core/auth/signedIntentService.js";
import type { TradingEngine } from "./tradingEngine.js";
import { signedTradingOrderSchema } from "../../utils/validation.js";
import {
  errorResponses,
  orderResultSchema,
  signedTradingOrderRequestSchema,
} from "../../docs/openapiSchemas.js";

export async function orderRoutes(
  app: FastifyInstance,
  tradingEngine: TradingEngine,
  signedIntentService: SignedIntentService,
  wsHub: WebSocketHub,
): Promise<void> {
  app.post(
    "/examples/trading/orders",
    {
      schema: {
        tags: ["Trading Example"],
        summary: "Submit a trading order backed by a generic SignedIntent",
        description:
          "Accepts a trading order plus a generic SignedIntent. The intent must use appId=trading-example, intentType=TRADING_ORDER and payloadHash=hash(order). The gateway verifies signer, nonce, deadline and replay protection before the example trading engine executes the order.",
        body: signedTradingOrderRequestSchema,
        response: {
          200: { description: "Order filled", ...orderResultSchema },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const body = signedTradingOrderSchema.parse(request.body);
      const verifiedOrder = await signedIntentService.verifySignedTradingOrder(
        body.order,
        body.intent,
        body.signature,
      );
      const result = tradingEngine.placeOrder(verifiedOrder);

      wsHub.publish({ type: "order:created", payload: result.order });
      wsHub.publish({ type: "trade:executed", payload: result.trade });
      wsHub.publish({
        type: "position:updated",
        payload: {
          userAddress: result.portfolio.userAddress,
          positions: result.portfolio.positions,
          ts: result.portfolio.ts,
        },
      });
      wsHub.publish({ type: "portfolio:updated", payload: result.portfolio });

      return result;
    },
  );
}
