import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { AppConfig } from "../../config.js";
import { unauthorized } from "../../utils/errors.js";

const productionLikeEnvironments = new Set(["production", "prod", "staging"]);

export function requireAdminAuth(appConfig: AppConfig) {
  return async (request: FastifyRequest) => {
    const token = extractBearerToken(request.headers.authorization);
    if (!token || token !== appConfig.gatewayAdminToken) {
      throw unauthorized(
        "ADMIN_AUTH_REQUIRED",
        "Missing or invalid admin bearer token",
      );
    }
  };
}

export function warnAboutAdminAuthConfig(
  appConfig: AppConfig,
  logger: FastifyBaseLogger,
): void {
  if (
    productionLikeEnvironments.has(appConfig.nodeEnv.toLowerCase()) &&
    !appConfig.gatewayAdminTokenConfigured
  ) {
    logger.warn(
      "GATEWAY_ADMIN_TOKEN is not set in a production-like NODE_ENV. Protected operator/admin endpoints will use the development fallback token; configure a strong token before exposing the backend.",
    );
  }

  if (appConfig.enableDemoRoutes) {
    logger.warn(
      "ENABLE_DEMO_ROUTES=true: /demo/* routes are enabled and require the admin bearer token. Keep demo routes local-only.",
    );
  }
}

function extractBearerToken(
  authorizationHeader: string | string[] | undefined,
): string | null {
  const raw = Array.isArray(authorizationHeader)
    ? authorizationHeader[0]
    : authorizationHeader;
  if (!raw) return null;

  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 2) return null;

  const [scheme, token] = parts;
  if (scheme.toLowerCase() !== "bearer") return null;
  return token.length > 0 ? token : null;
}
