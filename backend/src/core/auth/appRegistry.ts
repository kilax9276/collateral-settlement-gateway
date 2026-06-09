import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../../config.js";
import { forbidden, unauthorized } from "../../utils/errors.js";

export type RegisteredApp = {
  appId: string;
  name: string;
  appSecret: string;
  allowedSettlementTypes: string[];
  enabled: boolean;
};

type AppAuthHeaders = {
  appId: string | null;
  appSecret: string | null;
};

export const COLLATERAL_GATEWAY_SYSTEM_APP_ID = "collateral-gateway";

const defaultAllowedSettlementTypes: Record<string, string[]> = {
  "trading-example": ["TRADING_PNL"],
  "fantasy-trading-app": ["EXTERNAL_APP_REWARD"],
};

const defaultAppNames: Record<string, string> = {
  "trading-example": "Trading Reference Example",
  "fantasy-trading-app": "Fantasy Trading External App Example",
  [COLLATERAL_GATEWAY_SYSTEM_APP_ID]: "Collateral Gateway System Intents",
};

const collateralGatewaySystemApp: RegisteredApp = {
  appId: COLLATERAL_GATEWAY_SYSTEM_APP_ID,
  name: defaultAppNames[COLLATERAL_GATEWAY_SYSTEM_APP_ID],
  appSecret: "",
  allowedSettlementTypes: [],
  enabled: true,
};

export class AppRegistry {
  private readonly apps: Map<string, RegisteredApp>;

  constructor(registeredApps: string) {
    this.apps = parseRegisteredApps(registeredApps);
  }

  listApps(): RegisteredApp[] {
    return [...this.apps.values()].map((app) => ({ ...app }));
  }

  getApp(appId: string): RegisteredApp | null {
    return this.apps.get(normalizeAppId(appId)) ?? null;
  }

  requireRegisteredApp(appId: string): RegisteredApp {
    const app = this.getApp(appId);
    if (!app || !app.enabled) {
      throw forbidden(
        "APP_NOT_REGISTERED",
        `Application is not registered or enabled: ${appId}`,
      );
    }
    return app;
  }

  verifyAppRequest(appId: string, secret: string): RegisteredApp {
    const app = this.requireRegisteredApp(appId);
    if (secret !== app.appSecret) {
      throw unauthorized(
        "APP_AUTH_REQUIRED",
        "Missing or invalid app credentials",
      );
    }
    return app;
  }

  assertSettlementTypeAllowed(appId: string, settlementType: string): void {
    const app = this.requireRegisteredApp(appId);
    const normalizedType = settlementType.trim().toUpperCase();
    if (
      app.allowedSettlementTypes.length > 0 &&
      !app.allowedSettlementTypes.includes(normalizedType)
    ) {
      throw forbidden(
        "SETTLEMENT_TYPE_NOT_ALLOWED",
        `Application ${appId} is not allowed to submit ${normalizedType} settlements`,
      );
    }
  }
}

export type SettlementAuthContext =
  | { kind: "admin" }
  | { kind: "app"; app: RegisteredApp };

export function authorizeSettlementRequest(
  request: FastifyRequest,
  appConfig: AppConfig,
  body: { appId: string; settlementType: string },
): SettlementAuthContext {
  const adminToken = extractBearerToken(request.headers.authorization);
  if (adminToken) {
    if (adminToken !== appConfig.gatewayAdminToken) {
      throw unauthorized(
        "ADMIN_AUTH_REQUIRED",
        "Missing or invalid admin bearer token",
      );
    }
    return { kind: "admin" };
  }

  const registry = new AppRegistry(appConfig.registeredApps);
  const headers = extractAppAuthHeaders(request);
  if (!headers.appId || !headers.appSecret) {
    throw unauthorized(
      "APP_AUTH_REQUIRED",
      "Missing app credentials. Provide either Authorization: Bearer <admin-token> or X-App-Id and X-App-Secret headers.",
    );
  }

  if (headers.appId !== normalizeAppId(body.appId)) {
    throw forbidden(
      "APP_ID_MISMATCH",
      "Settlement appId must match X-App-Id header",
    );
  }

  const app = registry.verifyAppRequest(headers.appId, headers.appSecret);
  registry.assertSettlementTypeAllowed(app.appId, body.settlementType);
  return { kind: "app", app };
}

export function requireRegisteredIntentApp(
  appConfig: AppConfig,
  appId: string,
): RegisteredApp {
  if (normalizeAppId(appId) === COLLATERAL_GATEWAY_SYSTEM_APP_ID) {
    return { ...collateralGatewaySystemApp };
  }
  return new AppRegistry(appConfig.registeredApps).requireRegisteredApp(appId);
}

export function extractBearerToken(
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

function extractAppAuthHeaders(request: FastifyRequest): AppAuthHeaders {
  const rawAppId = firstHeaderValue(request.headers["x-app-id"]);
  const rawAppSecret = firstHeaderValue(request.headers["x-app-secret"]);
  return {
    appId: rawAppId ? normalizeAppId(rawAppId) : null,
    appSecret: rawAppSecret?.trim() ?? null,
  };
}

function parseRegisteredApps(rawRegistry: string): Map<string, RegisteredApp> {
  const apps = new Map<string, RegisteredApp>();
  for (const entry of rawRegistry.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) continue;

    const appId = normalizeAppId(trimmed.slice(0, separatorIndex));
    const appSecret = trimmed.slice(separatorIndex + 1).trim();
    if (!appId || !appSecret) continue;

    apps.set(appId, {
      appId,
      name: defaultAppNames[appId] ?? appId,
      appSecret,
      allowedSettlementTypes: defaultAllowedSettlementTypes[appId] ?? [],
      enabled: true,
    });
  }
  return apps;
}

function normalizeAppId(appId: string): string {
  return appId.trim();
}

function firstHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
