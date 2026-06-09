import { describe, expect, it } from "vitest";
import { config } from "../../backend/src/config.js";
import { Ledger } from "../../backend/src/core/storage/gatewayLedger.js";
import { MarketDataService } from "../../backend/src/examples/trading/marketData.js";
import { ReconciliationService } from "../../backend/src/core/reconciliation/reconciliationService.js";
import type { HexAddress } from "../../backend/src/types/domain.js";

const alice = "0x1000000000000000000000000000000000000001" as HexAddress;

describe("ReconciliationService", () => {
  it("reports OK when on-chain and off-chain balances match", async () => {
    const { service, ledger } = buildService({ onChainBalance: 10_000 });
    ledger.applyIndexedDeposit(alice, 10_000, "0xdeposit:0");

    const report = await service.reconcileUser(alice);

    expect(report.status).toBe("OK");
    expect(report.onChainBalance).toBe(10_000);
    expect(report.offChainBalance).toBe(10_000);
    expect(report.detectedIssues).toEqual([]);
  });

  it("reports MISMATCH when off-chain collateral drifts from the Vault balance", async () => {
    const { service, ledger } = buildService({ onChainBalance: 10_000 });
    ledger.applyIndexedDeposit(alice, 10_000, "0xdeposit:0");
    ledger.applyIndexedDeposit(alice, 1, "0xfake-drift:0");

    const report = await service.reconcileUser(alice);

    expect(report.status).toBe("MISMATCH");
    expect(report.onChainBalance).toBe(10_000);
    expect(report.offChainBalance).toBe(10_001);
    expect(report.detectedIssues).toContain("BALANCE_MISMATCH");
  });

  it("reports WARNING when realized P&L is pending settlement", async () => {
    const { service, ledger } = buildService({ onChainBalance: 10_000 });
    ledger.applyIndexedDeposit(alice, 10_000, "0xdeposit:0");
    ledger.addPendingSettlementPnl(alice, 96.7);

    const report = await service.reconcileUser(alice);

    expect(report.status).toBe("WARNING");
    expect(report.pendingRealizedPnl).toBe(96.7);
    expect(report.detectedIssues).toContain("PENDING_REALIZED_PNL");
  });
});

function buildService(options: {
  onChainBalance: number;
  onChainPendingWithdrawals?: number;
}) {
  const ledger = new Ledger();
  const marketData = new MarketDataService("BTC-USD", 65_000);
  const service = new ReconciliationService(ledger, marketData, {
    ...config,
    storageDriver: "memory",
    defaultSymbol: "BTC-USD",
    defaultBtcPrice: 65_000,
    maxLeverage: 5,
  });

  Object.defineProperty(service, "readOnChainState", {
    value: async () => ({
      available: true,
      balance: options.onChainBalance,
      pendingWithdrawals: options.onChainPendingWithdrawals ?? 0,
    }),
  });

  return { service, ledger };
}
