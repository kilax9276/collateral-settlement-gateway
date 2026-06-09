import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import type { SignedIntentService } from "./signedIntentService.js";
import { requireRegisteredIntentApp } from "./appRegistry.js";
import {
  nonceAddressParamsSchema,
  signedIntentRequestSchema,
} from "../../utils/validation.js";
import {
  addressParamSchema,
  errorResponses,
  signedIntentRequestSchema as signedIntentRequestOpenApiSchema,
  signedIntentVerificationSchema,
} from "../../docs/openapiSchemas.js";

export async function authRoutes(
  app: FastifyInstance,
  signedIntentService: SignedIntentService,
  appConfig: AppConfig,
): Promise<void> {
  const issueNonceHandler = async (request: { params: unknown }) => {
    const { address } = nonceAddressParamsSchema.parse(request.params);
    return signedIntentService.issueNonce(address);
  };

  const nonceRouteSchema = {
    tags: ["Signed Intents"],
    summary: "Issue EIP-712 signed-intent nonce",
    description:
      "Issues a one-time nonce for a wallet address. The nonce must be included in a signed off-chain intent and is consumed after successful verification.",
    params: addressParamSchema("address"),
    response: {
      200: {
        description: "Nonce issued",
        type: "object",
        required: ["userAddress", "nonce", "issuedAt"],
        properties: {
          userAddress: {
            type: "string",
            example: "0x0000000000000000000000000000000000000001",
          },
          nonce: { type: "string", example: "intentnonce_abc123" },
          issuedAt: { type: "string", format: "date-time" },
        },
      },
      ...errorResponses,
    },
  };

  app.get(
    "/auth/nonce/:address",
    { schema: nonceRouteSchema },
    issueNonceHandler,
  );
  app.post(
    "/auth/nonce/:address",
    { schema: nonceRouteSchema },
    issueNonceHandler,
  );

  app.post(
    "/intents/verify",
    {
      schema: {
        tags: ["Signed Intents"],
        summary: "Verify and store a signed off-chain intent",
        description:
          "Verifies the generic SignedIntent EIP-712 signature, signer, nonce and deadline. Successful verification consumes the nonce and stores the verified intent in SQLite/memory storage to prevent replay.",
        body: signedIntentRequestOpenApiSchema,
        response: {
          200: {
            description: "Signed intent verified and stored",
            ...signedIntentVerificationSchema,
          },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const body = signedIntentRequestSchema.parse(request.body);
      requireRegisteredIntentApp(appConfig, body.intent.appId);
      return signedIntentService.verifySignedIntent(
        body.intent,
        body.signature,
        {
          consumeNonce: true,
        },
      );
    },
  );
}
