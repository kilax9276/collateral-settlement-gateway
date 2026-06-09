import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";

export async function registerOpenApi(
  app: FastifyInstance,
  appConfig: AppConfig,
): Promise<void> {
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Collateral Settlement Gateway API",
        description:
          "A Web3 collateral settlement gateway for off-chain applications with an example trading use case.",
        version: "0.1.0",
      },
      components: {
        securitySchemes: {
          AdminBearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "admin token",
            description:
              "Admin/operator bearer token from GATEWAY_ADMIN_TOKEN. Required for withdrawal approval, admin endpoints, market-data mutations and demo routes. Also accepted for settlement submission.",
          },
          AppAuthHeaders: {
            type: "apiKey",
            in: "header",
            name: "X-App-Id",
            description:
              "Registered app credentials for external settlement submission. Send X-App-Id and X-App-Secret headers together; the request body appId must match X-App-Id.",
          },
          // Backward-compatible aliases for earlier generated specs and clients.
          BearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "admin token",
            description: "Deprecated alias. Use AdminBearerAuth.",
          },
          AppIdAuth: {
            type: "apiKey",
            in: "header",
            name: "X-App-Id",
            description: "Deprecated alias. Use AppAuthHeaders.",
          },
          AppSecretAuth: {
            type: "apiKey",
            in: "header",
            name: "X-App-Secret",
            description:
              "Deprecated companion header for AppAuthHeaders. External settlements still require X-App-Secret at runtime.",
          },
        },
      },
      servers: [
        {
          url: `http://${appConfig.host === "0.0.0.0" ? "localhost" : appConfig.host}:${appConfig.port}`,
          description: "Local backend",
        },
      ],
      tags: [
        {
          name: "Core Gateway",
          description:
            "Core gateway liveness and product-level infrastructure endpoints.",
        },
        {
          name: "Signed Intents",
          description:
            "Generic EIP-712 off-chain action authorization, nonce issuance, verification and replay protection.",
        },
        {
          name: "Collateral",
          description:
            "Collateral contract metadata and user collateral/portfolio snapshots anchored to the gateway ledger.",
        },
        {
          name: "Settlements",
          description:
            "Generic auditable settlements that apply amountDelta to on-chain Vault balances with reasonHash and reference metadata.",
        },
        {
          name: "Withdrawals",
          description: "Guarded withdrawal requests and operator approvals.",
        },
        {
          name: "Reconciliation",
          description:
            "On-chain/off-chain state comparison for balances, pending withdrawals, open positions and settlements.",
        },
        {
          name: "Admin",
          description:
            "Operator and system health endpoints for running the gateway.",
        },
        {
          name: "Trading Example",
          description:
            "Reference use case showing low-latency off-chain trading logic backed by core gateway collateral, signed intents and settlements.",
        },
        {
          name: "Demo Only",
          description:
            "Local walkthrough helpers. Disabled unless ENABLE_DEMO_ROUTES=true.",
        },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
    staticCSP: false,
  });

  app.get("/openapi.json", { schema: { hide: true } }, async () => {
    return (app as FastifyInstance & { swagger: () => unknown }).swagger();
  });
}
