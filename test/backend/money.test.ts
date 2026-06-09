import { describe, expect, it } from "vitest";
import {
  calculateFee,
  calculateMarginUsed,
  calculateNotional,
  calculatePnl,
  calculateWeightedAveragePrice,
  decimalAdd,
  decimalSub,
  formatMicroUsdc,
  formatScaledDecimal,
  parseSettlementAmount,
  roundMoney,
  toMicroUsdc,
  toScaledDecimal,
} from "../../backend/src/core/money/money.js";

describe("money helpers", () => {
  it("uses scaled integer parsing for common decimal additions", () => {
    expect(decimalAdd(0.1, 0.2)).toBe(0.3);
    expect(decimalSub(1, 0.9)).toBe(0.1);
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
  });

  it("converts USDC amounts to microUSDC deterministically", () => {
    expect(toMicroUsdc("96.7")).toBe(96_700_000n);
    expect(toMicroUsdc("+25")).toBe(25_000_000n);
    expect(toMicroUsdc("0.000001")).toBe(1n);
    expect(toMicroUsdc("0.0000005")).toBe(1n);
  });

  it("formats scaled decimal values without trailing zeros", () => {
    expect(formatScaledDecimal(toScaledDecimal("65000.12345678"))).toBe(
      "65000.12345678",
    );
    expect(formatScaledDecimal(toScaledDecimal("-1.50000000"))).toBe("-1.5");
  });

  it("calculates deterministic notional, fees, P&L and margin", () => {
    expect(calculateNotional("0.05", "65000")).toBe(3250);
    expect(calculateFee("3250", 5)).toBe(1.625);
    expect(calculatePnl("0.05", "65000", "67000")).toBe(100);
    expect(calculateMarginUsed("0.05", "67000", 5)).toBe(670);
  });

  it("calculates fees deterministically with half-up scaled integer rounding", () => {
    expect(calculateFee("1234.56789", 5)).toBe(0.61728395);
    expect(calculateFee("0.000001", 5)).toBe(0);
    expect(calculateFee("100000", 25)).toBe(250);
  });

  it("converts settlement amount deltas to signed microUSDC units", () => {
    expect(parseSettlementAmount("96.7")).toMatchObject({
      microUsdc: 96_700_000n,
      formatted: "96.7",
      decimal: 96.7,
    });
    expect(parseSettlementAmount("-3.2500004")).toMatchObject({
      microUsdc: -3_250_000n,
      formatted: "-3.25",
      decimal: -3.25,
    });
    expect(formatMicroUsdc(parseSettlementAmount("0.0000005").microUsdc)).toBe(
      "0.000001",
    );
  });

  it("keeps deterministic P&L for decimal quantities and prices", () => {
    const grossPnl = calculatePnl("0.075", "65000.125", "67111.375");
    const closingNotional = calculateNotional("0.075", "67111.375");
    const fee = calculateFee(closingNotional.toString(), 5);

    expect(grossPnl).toBe(158.34375);
    expect(closingNotional).toBe(5033.353125);
    expect(fee).toBe(2.51667656);
    expect(decimalSub(grossPnl, fee)).toBe(155.82707344);
  });

  it("calculates weighted average entry price deterministically", () => {
    expect(
      calculateWeightedAveragePrice({
        existingQuantity: "0.1",
        existingAvgPrice: "65000",
        fillQuantity: "0.2",
        fillPrice: "68000",
      }),
    ).toBe(67000);
  });
});
