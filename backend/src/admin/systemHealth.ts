import type { FastifyInstance } from "fastify";
import { errorResponses } from "../docs/openapiSchemas.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/health",
    {
      schema: {
        tags: ["Core Gateway"],
        summary: "Service health check",
        description:
          "Returns basic liveness information for the Collateral Settlement Gateway process and current operating mode.",
        response: {
          200: {
            description: "Backend is healthy",
            type: "object",
            required: ["status", "service", "mode", "ts"],
            properties: {
              status: { type: "string", example: "ok" },
              service: {
                type: "string",
                example: "collateral-settlement-gateway-backend",
              },
              mode: {
                type: "string",
                example:
                  "on-chain collateral + signed off-chain intents + auditable settlement",
              },
              ts: { type: "string", format: "date-time" },
            },
          },
          ...errorResponses,
        },
      },
    },
    async () => ({
      status: "ok",
      service: "collateral-settlement-gateway-backend",
      mode: "on-chain collateral + signed off-chain intents + auditable settlement",
      ts: new Date().toISOString(),
    }),
  );
}
