// Trading-specific risk rules currently reuse the gateway RiskService.
// This file makes the example boundary explicit and gives future production
// work a clear place to move leverage, notional and market-data rules.
export { RiskService as TradingRiskRules } from "../../core/risk/riskService.js";
export type { OrderRiskInput } from "../../core/risk/riskService.js";
