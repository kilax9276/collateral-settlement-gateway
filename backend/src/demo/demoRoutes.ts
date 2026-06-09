import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { WebSocketHub } from "../core/websocket/websocketHub.js";
import type { DemoService } from "./demoScenario.js";
import { requireAdminAuth } from "../core/auth/adminAuth.js";

const demoResponseSchema = {
  type: "object",
  additionalProperties: true,
};

const demoRouteDescription =
  "Demo only. Disabled unless ENABLE_DEMO_ROUTES=true. When enabled, these routes require the admin bearer token and should not be exposed in production.";

export async function demoRoutes(
  app: FastifyInstance,
  demoService: DemoService,
  wsHub: WebSocketHub,
  appConfig: AppConfig,
): Promise<void> {
  const requireAdmin = requireAdminAuth(appConfig);
  app.get(
    "/demo/state",
    {
      preHandler: requireAdmin,
      schema: {
        tags: ["Demo Only"],
        summary: "Get local demo walkthrough state",
        description: demoRouteDescription,
        security: [{ AdminBearerAuth: [] }],
        response: { 200: demoResponseSchema },
      },
    },
    async () => demoService.getState(),
  );

  const actions: Array<
    [
      string,
      string,
      () => Promise<Awaited<ReturnType<DemoService["mintDemoUsdc"]>>>,
    ]
  > = [
    [
      "mint",
      "Mint local MockUSDC and fund demo insurance liquidity",
      () => demoService.mintDemoUsdc(),
    ],
    [
      "approve",
      "Approve the Vault to spend the demo wallet collateral",
      () => demoService.approveVault(),
    ],
    [
      "deposit",
      "Deposit demo collateral into the Vault",
      () => demoService.deposit(),
    ],
    [
      "open-long",
      "Open a signed trading-example long position",
      () => demoService.openLong(),
    ],
    [
      "move-price",
      "Move the mock market price for the trading walkthrough",
      () => demoService.movePriceUp(),
    ],
    [
      "close-position",
      "Close the demo trading-example position",
      () => demoService.closePosition(),
    ],
    [
      "settle",
      "Submit the demo trading P&L as a generic settlement",
      () => demoService.settle(),
    ],
    [
      "request-withdraw",
      "Request a demo withdrawal on-chain",
      () => demoService.requestWithdraw(),
    ],
    [
      "approve-withdraw",
      "Approve the pending demo withdrawal after risk checks",
      () => demoService.approveWithdraw(),
    ],
    [
      "withdraw",
      "Withdraw the approved demo collateral from the Vault",
      () => demoService.withdraw(),
    ],
  ];

  for (const [name, summary, handler] of actions) {
    app.post(
      `/demo/${name}`,
      {
        preHandler: requireAdmin,
        schema: {
          tags: ["Demo Only"],
          summary,
          description: demoRouteDescription,
          security: [{ AdminBearerAuth: [] }],
          response: { 200: demoResponseSchema },
        },
      },
      async () => {
        const result = await handler();
        publishDemoEvents(result, wsHub);
        return result;
      },
    );
  }
}

function publishDemoEvents(
  result: Awaited<ReturnType<DemoService["mintDemoUsdc"]>>,
  wsHub: WebSocketHub,
): void {
  wsHub.publish({
    type: "portfolio:updated",
    payload: result.state.portfolio,
  });

  if (result.order)
    wsHub.publish({ type: "order:created", payload: result.order });
  if (result.trade)
    wsHub.publish({ type: "trade:executed", payload: result.trade });
  if (result.settlement)
    wsHub.publish({ type: "settlement:confirmed", payload: result.settlement });
  if (result.withdrawal) {
    const type =
      result.withdrawal.status === "ONCHAIN_APPROVED"
        ? "withdrawal:approved"
        : "withdrawal:requested";
    wsHub.publish({ type, payload: result.withdrawal });
  }
}
