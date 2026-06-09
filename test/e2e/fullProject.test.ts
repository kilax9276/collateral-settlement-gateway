import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AppError } from "../../backend/src/utils/errors.js";
import {
  buildSignedIntentTypedData,
  buildTradingOrderIntent,
  buildWithdrawalRequestIntent,
} from "../../backend/src/core/auth/signedIntentService.js";
import type {
  OrderResult,
  SignedOrderPayload,
} from "../../backend/src/types/domain.js";
import {
  alice,
  aliceWallet,
  adminHeaders,
  chainId,
  createE2EHarness,
  insuranceBalance,
  mintAndDeposit,
  parseUsdc,
  runCommand,
  tradingAppHeaders,
  stopSharedHardhatNode,
  vaultBalance,
  waitForIndexedPortfolio,
  writeAndWait,
  type E2EHarness,
} from "./helpers.js";

describe("full project e2e coverage", () => {
  let harness: E2EHarness | null = null;

  afterAll(async () => {
    if (harness) await harness.cleanup();
    await stopSharedHardhatNode();
    // viem/EDR can keep low-level handles open after a local RPC e2e run.
    // test:e2e is always the last script in npm test, so exit after Vitest flushes results.
    setTimeout(() => process.exit(0), 500);
  });

  it("indexes Vault events, verifies signed orders, blocks unsafe withdrawals, and settles P&L through CollateralVault", async () => {
    harness = await createE2EHarness({ startIndexer: true });

    await mintAndDeposit(harness.contracts, "10000", "500");
    expect(await insuranceBalance(harness.contracts)).toBe(500);

    const afterDeposit = await waitForIndexedPortfolio(
      harness.app,
      alice.address,
      (portfolio) => portfolio.collateral === 10_000,
    );
    expect(afterDeposit.collateral).toBe(10_000);
    expect(await vaultBalance(harness.contracts, alice.address)).toBe(10_000);

    const reconciliationAfterDeposit = await harness.app.inject({
      method: "GET",
      url: `/admin/reconciliation/${alice.address}`,
      headers: adminHeaders,
    });
    expect(reconciliationAfterDeposit.statusCode).toBe(200);
    expect(reconciliationAfterDeposit.json()).toMatchObject({
      userAddress: alice.address,
      onChainBalance: 10_000,
      offChainBalance: 10_000,
      status: "OK",
      detectedIssues: [],
    });

    const systemHealth = await harness.app.inject({
      method: "GET",
      url: "/admin/system-health",
      headers: adminHeaders,
    });
    expect(systemHealth.statusCode).toBe(200);
    expect(systemHealth.json()).toMatchObject({
      chainId,
      vaultAddress: harness.contracts.collateralVault.address,
      sqlite: { driver: "sqlite", status: "OK" },
    });

    const unsignedRequest = await harness.app.inject({
      method: "POST",
      url: "/withdrawals/request",
      payload: { userAddress: alice.address, amount: 1000 },
    });
    expect(unsignedRequest.statusCode).toBe(400);

    const withdrawalIntentId = await createVerifiedWithdrawalIntent(
      harness,
      1000,
    );

    const wrongAmountRequest = await harness.app.inject({
      method: "POST",
      url: "/withdrawals/request",
      payload: {
        userAddress: alice.address,
        amount: 1001,
        signedIntentId: withdrawalIntentId,
      },
    });
    expect(wrongAmountRequest.statusCode).toBe(409);
    expect(wrongAmountRequest.json().error.code).toBe(
      "WITHDRAWAL_INTENT_PAYLOAD_HASH_MISMATCH",
    );

    const request = await harness.app.inject({
      method: "POST",
      url: "/withdrawals/request",
      payload: {
        userAddress: alice.address,
        amount: 1000,
        signedIntentId: withdrawalIntentId,
      },
    });
    expect(request.statusCode).toBe(200);
    expect(request.json().withdrawal.status).toBe("ONCHAIN_REQUESTED");
    expect(request.json().portfolio.pendingWithdrawals).toBe(1000);

    const reusedWithdrawalIntent = await harness.app.inject({
      method: "POST",
      url: "/withdrawals/request",
      payload: {
        userAddress: alice.address,
        amount: 1000,
        signedIntentId: withdrawalIntentId,
      },
    });
    expect(reusedWithdrawalIntent.statusCode).toBe(409);
    expect(reusedWithdrawalIntent.json().error.code).toBe(
      "WITHDRAWAL_INTENT_ALREADY_CONSUMED",
    );

    const open = await postSignedOrder(harness, {
      side: "BUY",
      quantity: 0.05,
      clientOrderId: "integration-buy-1",
    });
    expect(open.statusCode).toBe(200);
    expect((open.json() as OrderResult).portfolio.positions[0].quantity).toBe(
      0.05,
    );

    const rejectedApproval = await harness.app.inject({
      method: "POST",
      url: `/withdrawals/approve/${alice.address}`,
      headers: adminHeaders,
      payload: { amount: 1000 },
    });
    expect(rejectedApproval.statusCode).toBe(409);
    expect(rejectedApproval.json().error.code).toBe("OPEN_POSITION_EXISTS");

    harness.services.marketData.setPrice("BTC-USD", 67_000);
    const close = await postSignedOrder(harness, {
      side: "SELL",
      quantity: 0.05,
      clientOrderId: "integration-sell-1",
    });
    expect(close.statusCode).toBe(200);
    expect((close.json() as OrderResult).portfolio.pendingSettlementPnl).toBe(
      96.7,
    );

    const reconciliationBeforeSettlement = await harness.app.inject({
      method: "GET",
      url: `/admin/reconciliation/${alice.address}`,
      headers: adminHeaders,
    });
    expect(reconciliationBeforeSettlement.statusCode).toBe(200);
    expect(reconciliationBeforeSettlement.json().status).toBe("WARNING");
    expect(reconciliationBeforeSettlement.json().pendingRealizedPnl).toBe(96.7);
    expect(reconciliationBeforeSettlement.json().detectedIssues).toContain(
      "PENDING_REALIZED_PNL",
    );

    const settlementRequest =
      harness!.services.settlementService.buildTradingPnlSettlementRequest(
        alice.address,
      );
    expect(settlementRequest).toMatchObject({
      appId: "trading-example",
      settlementType: "TRADING_PNL",
      amountDelta: "96.7",
    });

    const settlementResponse = await harness.app.inject({
      method: "POST",
      url: "/settlements",
      headers: tradingAppHeaders,
      payload: settlementRequest,
    });
    expect(settlementResponse.statusCode).toBe(200);
    const result = settlementResponse.json() as {
      settlement: {
        settlementId: `0x${string}`;
        reasonHash: `0x${string}`;
        txHash: `0x${string}`;
        amountDelta: number;
        pnl: number;
        appId: string;
        settlementType: string;
        referenceIds: string[];
        metadata?: Record<string, unknown>;
        status: string;
      };
      portfolio: {
        pendingSettlementPnl: number;
        collateral: number;
        settlements: Array<Record<string, unknown>>;
      };
    };
    expect(result.settlement.status).toBe("ONCHAIN_CONFIRMED");
    expect(result.settlement.settlementId).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.settlement.reasonHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.settlement.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.settlement.amountDelta).toBe(96.7);
    expect(result.settlement.pnl).toBe(96.7);
    expect(result.settlement.appId).toBe("trading-example");
    expect(result.settlement.settlementType).toBe("TRADING_PNL");
    expect(result.settlement.referenceIds.length).toBeGreaterThan(0);
    expect(result.portfolio.pendingSettlementPnl).toBe(0);
    expect(result.portfolio.collateral).toBe(10096.7);
    expect(result.portfolio.settlements[0]).toMatchObject({
      settlementId: result.settlement.settlementId,
      reasonHash: result.settlement.reasonHash,
      txHash: result.settlement.txHash,
      appId: "trading-example",
      settlementType: "TRADING_PNL",
      amountDelta: 96.7,
      status: "ONCHAIN_CONFIRMED",
    });

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));

    const settlementRecord = await harness.app.inject({
      method: "GET",
      url: `/settlements/${result.settlement.settlementId}`,
    });
    expect(settlementRecord.statusCode).toBe(200);
    expect(settlementRecord.json()).toMatchObject({
      settlementId: result.settlement.settlementId,
      amountDelta: 96.7,
      settlementType: "TRADING_PNL",
    });

    const settlementReport = await harness.app.inject({
      method: "GET",
      url: `/settlements/${result.settlement.settlementId}/report`,
    });
    expect(settlementReport.statusCode).toBe(200);
    const report = settlementReport.json();
    expect(report).toMatchObject({
      settlementId: result.settlement.settlementId,
      userAddress: alice.address.toLowerCase(),
      appId: "trading-example",
      settlementType: "TRADING_PNL",
      amountDelta: 96.7,
      reasonHash: result.settlement.reasonHash,
      status: "ONCHAIN_CONFIRMED",
    });
    expect(report.referenceIds).toEqual(result.settlement.referenceIds);
    expect(report.metadata).toMatchObject({ realizedPnl: 96.7 });
    expect(report.offChainCalculation.reasonHash).toBe(
      result.settlement.reasonHash,
    );
    expect(report.signedIntentIds).toHaveLength(2);
    expect(
      report.signedIntentIds.every((id: string) => id.startsWith("intent_")),
    ).toBe(true);
    expect(report.linkedSignedIntents).toHaveLength(2);
    expect(
      report.linkedSignedIntents.every(
        (intent: { status: string; appId: string; intentType: string }) =>
          intent.status === "CONSUMED" &&
          intent.appId === "trading-example" &&
          intent.intentType === "TRADING_ORDER",
      ),
    ).toBe(true);
    expect(report.audit).toMatchObject({
      authorization: "app",
      trustedOperatorSettlement: false,
      warnings: [],
    });

    const reusedIntentSettlement = await harness.app.inject({
      method: "POST",
      url: "/settlements",
      headers: tradingAppHeaders,
      payload: {
        userAddress: alice.address,
        appId: "trading-example",
        settlementType: "TRADING_PNL",
        amountDelta: "+1",
        reasonHash:
          "0x2222222222222222222222222222222222222222222222222222222222222222",
        referenceIds: ["reuse-check"],
        signedIntentIds: report.signedIntentIds,
      },
    });
    expect(reusedIntentSettlement.statusCode).toBe(409);
    expect(reusedIntentSettlement.json().error.code).toBe(
      "SIGNED_INTENT_ALREADY_CONSUMED",
    );

    expect(report.onChain).toMatchObject({
      txHash: result.settlement.txHash,
      eventName: "SettlementApplied",
      contractAddress: harness.contracts.collateralVault.address,
    });
    expect(Number(report.onChain.blockNumber)).toBeGreaterThan(0);
    expect(report.trading).toMatchObject({
      symbol: "BTC-USD",
      entryPrice: 65000,
      exitPrice: 67000,
      quantity: 0.05,
      grossPnl: 100,
      fees: 3.3,
      netPnl: 96.7,
      tradeIds: result.settlement.referenceIds,
    });

    const cliReport = await runCommand(
      "npm",
      ["run", "settlement:report", "--", result.settlement.settlementId],
      {
        STORAGE_DRIVER: "sqlite",
        SQLITE_PATH: join(harness.tempDir, "app.db"),
        INDEXER_ENABLED: "false",
      },
      { silent: true, timeoutMs: 30_000 },
    );
    expect(cliReport.stdout).toContain("Settlement Audit Report");
    expect(cliReport.stdout).toContain(`User: ${alice.address.toLowerCase()}`);
    expect(cliReport.stdout).toContain("Amount Delta: 96.7");
    expect(cliReport.stdout).toContain(
      `Reason Hash: ${result.settlement.reasonHash}`,
    );
    expect(cliReport.stdout).toContain(result.settlement.txHash);
    expect(cliReport.stdout).toContain("Final Status: ONCHAIN_CONFIRMED");

    expect(await vaultBalance(harness.contracts, alice.address)).toBe(10096.7);
    expect(await insuranceBalance(harness.contracts)).toBe(403.3);

    const portfolioResponse = await harness.app.inject({
      method: "GET",
      url: `/portfolio/${alice.address}`,
    });
    expect(portfolioResponse.statusCode).toBe(200);
    expect(portfolioResponse.json().settlements[0]).toMatchObject({
      settlementId: result.settlement.settlementId,
      reasonHash: result.settlement.reasonHash,
      txHash: result.settlement.txHash,
    });

    expect(() =>
      harness!.services.settlementService.buildTradingPnlSettlementRequest(
        alice.address,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "NO_PENDING_SETTLEMENT",
      } satisfies Partial<AppError>),
    );

    const reconciliationAfterSettlement = await harness.app.inject({
      method: "GET",
      url: `/admin/reconciliation/${alice.address}`,
      headers: adminHeaders,
    });
    expect(reconciliationAfterSettlement.statusCode).toBe(200);
    expect(reconciliationAfterSettlement.json().status).toBe("WARNING");
    expect(reconciliationAfterSettlement.json().detectedIssues).toContain(
      "PENDING_WITHDRAWAL",
    );

    const approval = await harness.app.inject({
      method: "POST",
      url: `/withdrawals/approve/${alice.address}`,
      headers: adminHeaders,
      payload: { amount: 1000 },
    });
    expect(approval.statusCode).toBe(200);
    expect(approval.json().withdrawal.status).toBe("ONCHAIN_APPROVED");
    expect(approval.json().portfolio.approvedWithdrawals).toBe(1000);

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));

    await writeAndWait(
      aliceWallet.writeContract({
        address: harness.contracts.collateralVault.address,
        abi: harness.contracts.collateralVault.abi,
        functionName: "withdrawApproved",
        args: [parseUsdc("1000")],
      }),
    );

    const afterWithdraw = await waitForIndexedPortfolio(
      harness.app,
      alice.address,
      (portfolio) =>
        portfolio.collateral === 9096.7 && portfolio.approvedWithdrawals === 0,
    );
    expect(afterWithdraw.collateral).toBe(9096.7);
    expect(afterWithdraw.approvedWithdrawals).toBe(0);
    expect(await vaultBalance(harness.contracts, alice.address)).toBe(9096.7);

    const reconciliationAfterWithdraw = await harness.app.inject({
      method: "GET",
      url: `/admin/reconciliation/${alice.address}`,
      headers: adminHeaders,
    });
    expect(reconciliationAfterWithdraw.statusCode).toBe(200);
    expect(reconciliationAfterWithdraw.json().status).toBe("OK");

    const adminSettlement = await harness.app.inject({
      method: "POST",
      url: "/settlements",
      headers: adminHeaders,
      payload: {
        userAddress: alice.address,
        appId: "ops-adjustment",
        settlementType: "MANUAL_ADJUSTMENT",
        amountDelta: "+1",
        reasonHash:
          "0x3333333333333333333333333333333333333333333333333333333333333333",
        referenceIds: ["admin-adjustment-001"],
        signedIntentIds: [],
        metadata: { source: "e2e-admin-check" },
      },
    });
    expect(adminSettlement.statusCode).toBe(200);

    const adminReport = await harness.app.inject({
      method: "GET",
      url: `/settlements/${adminSettlement.json().settlement.settlementId}/report`,
    });
    expect(adminReport.statusCode).toBe(200);
    expect(adminReport.json().signedIntentIds).toEqual([]);
    expect(adminReport.json().audit).toMatchObject({
      authorization: "admin",
      trustedOperatorSettlement: true,
    });
    expect(adminReport.json().audit.warnings[0]).toContain(
      "trusted operator/admin",
    );
  }, 120_000);
});

async function createVerifiedWithdrawalIntent(
  harness: E2EHarness,
  amount: number,
): Promise<string> {
  const nonce = await harness.app.inject({
    method: "GET",
    url: `/auth/nonce/${alice.address}`,
  });
  expect(nonce.statusCode).toBe(200);

  const intent = buildWithdrawalRequestIntent({
    userAddress: alice.address,
    amount,
    chainId,
    vaultAddress: harness.contracts.collateralVault.address,
    nonce: nonce.json().nonce,
    deadline: Math.floor(Date.now() / 1000) + 300,
  });
  const signature = await alice.signTypedData(
    buildSignedIntentTypedData({
      chainId,
      verifyingContract: harness.contracts.collateralVault.address,
      intent,
    }),
  );

  const verified = await harness.app.inject({
    method: "POST",
    url: "/intents/verify",
    payload: { intent, signature },
  });
  expect(verified.statusCode).toBe(200);
  return verified.json().intentId as string;
}

async function postSignedOrder(
  harness: E2EHarness,
  overrides: Partial<SignedOrderPayload>,
) {
  const nonce = await harness.app.inject({
    method: "GET",
    url: `/auth/nonce/${alice.address}`,
  });
  expect(nonce.statusCode).toBe(200);

  const order = {
    userAddress: overrides.userAddress ?? alice.address,
    symbol: overrides.symbol ?? "BTC-USD",
    side: overrides.side ?? "BUY",
    type: "MARKET" as const,
    quantity: overrides.quantity ?? 0.01,
    clientOrderId: overrides.clientOrderId ?? `integration-${Date.now()}`,
  };
  const intent = buildTradingOrderIntent({
    order,
    nonce: overrides.nonce ?? nonce.json().nonce,
    deadline: overrides.deadline ?? Math.floor(Date.now() / 1000) + 300,
  });
  const signature = await alice.signTypedData(
    buildSignedIntentTypedData({
      chainId,
      verifyingContract: harness.contracts.collateralVault.address,
      intent,
    }),
  );

  return harness.app.inject({
    method: "POST",
    url: "/examples/trading/orders",
    payload: { order, intent, signature },
  });
}
