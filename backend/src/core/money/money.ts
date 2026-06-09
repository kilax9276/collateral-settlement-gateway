export const USDC_DECIMALS = 6;
export const USDC_SCALE = 10n ** BigInt(USDC_DECIMALS);

export const MONEY_DECIMALS = 8;
export const MONEY_SCALE = 10n ** BigInt(MONEY_DECIMALS);

export type DecimalInput = number | string | bigint;

export type MicroUsdc = bigint & { readonly __brand: "MicroUsdc" };
export type ScaledDecimal = bigint & { readonly __brand: "ScaledDecimal" };

export type SettlementAmount = {
  /** Signed token-native microUSDC amount used for contract calls. */
  microUsdc: MicroUsdc;
  /** Human-readable decimal string normalized to USDC precision. */
  formatted: string;
  /** Decimal number kept only for API/display compatibility. */
  decimal: number;
};

export function roundMoney(value: number): number {
  return Number(formatScaledDecimal(toScaledDecimal(value), MONEY_DECIMALS));
}

export function toMicroUsdc(amount: DecimalInput): MicroUsdc {
  return toScaledDecimal(amount, USDC_DECIMALS) as unknown as MicroUsdc;
}

export function fromMicroUsdc(amount: bigint): number {
  return Number(formatScaledDecimal(amount, USDC_DECIMALS));
}

export function formatMicroUsdc(amount: bigint): string {
  return formatScaledDecimal(amount, USDC_DECIMALS);
}

export function parseSettlementAmount(
  amountDelta: DecimalInput,
): SettlementAmount {
  const microUsdc = toMicroUsdc(amountDelta);
  return {
    microUsdc,
    formatted: formatMicroUsdc(microUsdc),
    decimal: fromMicroUsdc(microUsdc),
  };
}

export function addMicroUsdc(left: MicroUsdc, right: MicroUsdc): MicroUsdc {
  return (left + right) as MicroUsdc;
}

export function subMicroUsdc(left: MicroUsdc, right: MicroUsdc): MicroUsdc {
  return (left - right) as MicroUsdc;
}

export function decimalAdd(left: DecimalInput, right: DecimalInput): number {
  return fromMoneyScaled(toScaledDecimal(left) + toScaledDecimal(right));
}

export function decimalSub(left: DecimalInput, right: DecimalInput): number {
  return fromMoneyScaled(toScaledDecimal(left) - toScaledDecimal(right));
}

export function decimalMul(left: DecimalInput, right: DecimalInput): number {
  const product = toScaledDecimal(left) * toScaledDecimal(right);
  return fromMoneyScaled(divRound(product, MONEY_SCALE));
}

export function decimalDiv(left: DecimalInput, right: DecimalInput): number {
  const denominator = toScaledDecimal(right);
  if (denominator === 0n) throw new Error("Cannot divide by zero");
  return fromMoneyScaled(
    divRound(toScaledDecimal(left) * MONEY_SCALE, denominator),
  );
}

export function decimalAbs(value: DecimalInput): number {
  const scaled = toScaledDecimal(value);
  return fromMoneyScaled(scaled < 0n ? -scaled : scaled);
}

export function decimalCompare(
  left: DecimalInput,
  right: DecimalInput,
): -1 | 0 | 1 {
  const leftScaled = toScaledDecimal(left);
  const rightScaled = toScaledDecimal(right);
  if (leftScaled < rightScaled) return -1;
  if (leftScaled > rightScaled) return 1;
  return 0;
}

export function calculateNotional(
  quantity: DecimalInput,
  price: DecimalInput,
): number {
  return decimalMul(quantity, price);
}

export function calculateFee(notional: DecimalInput, feeBps: number): number {
  if (!Number.isInteger(feeBps) || feeBps < 0) {
    throw new Error("Fee bps must be a non-negative integer");
  }
  return fromMoneyScaled(
    divRound(toScaledDecimal(notional) * BigInt(feeBps), 10_000n),
  );
}

export function calculatePnl(
  quantity: DecimalInput,
  entryPrice: DecimalInput,
  exitPrice: DecimalInput,
): number {
  return decimalMul(quantity, decimalSub(exitPrice, entryPrice));
}

export function calculateWeightedAveragePrice(args: {
  existingQuantity: DecimalInput;
  existingAvgPrice: DecimalInput;
  fillQuantity: DecimalInput;
  fillPrice: DecimalInput;
}): number {
  const existingQuantity = toScaledDecimal(args.existingQuantity);
  const fillQuantity = toScaledDecimal(args.fillQuantity);
  const newQuantity = existingQuantity + fillQuantity;
  if (newQuantity <= 0n)
    throw new Error("Weighted average quantity must be positive");

  const existingCost =
    (existingQuantity * toScaledDecimal(args.existingAvgPrice)) / MONEY_SCALE;
  const fillCost =
    (fillQuantity * toScaledDecimal(args.fillPrice)) / MONEY_SCALE;
  return fromMoneyScaled(
    divRound((existingCost + fillCost) * MONEY_SCALE, newQuantity),
  );
}

export function calculateMarginUsed(
  quantity: DecimalInput,
  markPrice: DecimalInput,
  maxLeverage: number,
): number {
  if (!Number.isFinite(maxLeverage) || maxLeverage <= 0) {
    throw new Error("maxLeverage must be positive");
  }
  return decimalDiv(
    calculateNotional(decimalAbs(quantity), markPrice),
    maxLeverage,
  );
}

export function toScaledDecimal(
  value: DecimalInput,
  decimals = MONEY_DECIMALS,
): ScaledDecimal {
  if (typeof value === "bigint") return value as ScaledDecimal;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Decimal value must be finite");
    return parseDecimalToScaledInteger(
      numberToPlainDecimal(value, decimals + 6),
      decimals,
    ) as ScaledDecimal;
  }
  return parseDecimalToScaledInteger(value, decimals) as ScaledDecimal;
}

export function formatScaledDecimal(
  value: bigint,
  decimals = MONEY_DECIMALS,
): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

function fromMoneyScaled(value: bigint): number {
  return Number(formatScaledDecimal(value, MONEY_DECIMALS));
}

function parseDecimalToScaledInteger(raw: string, decimals: number): bigint {
  const value = raw.trim();
  if (!/^[+-]?(\d+|\d*\.\d+)(e[+-]?\d+)?$/i.test(value)) {
    throw new Error(`Invalid decimal value: ${raw}`);
  }

  const normalized = value.toLowerCase().includes("e")
    ? expandExponential(value)
    : value;
  const negative = normalized.startsWith("-");
  const unsigned = normalized.replace(/^[+-]/, "");
  const [wholePartRaw, fractionPartRaw = ""] = unsigned.split(".");
  const wholePart = wholePartRaw || "0";
  const fractionPart = fractionPartRaw.padEnd(decimals + 1, "0");
  const keptFraction = fractionPart.slice(0, decimals);
  const roundingDigit = Number(fractionPart[decimals] ?? "0");
  const scale = 10n ** BigInt(decimals);
  let scaled = BigInt(wholePart) * scale + BigInt(keptFraction || "0");
  if (roundingDigit >= 5) scaled += 1n;
  return negative ? -scaled : scaled;
}

function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("Cannot divide by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const rounded = (n + d / 2n) / d;
  return negative ? -rounded : rounded;
}

function numberToPlainDecimal(value: number, maxDecimals: number): string {
  if (Number.isInteger(value)) return value.toString();
  const fixed = value.toFixed(Math.min(Math.max(maxDecimals, 0), 20));
  return fixed.replace(/\.?0+$/, "");
}

function expandExponential(value: string): string {
  const [coefficient, exponentRaw] = value.toLowerCase().split("e");
  const exponent = Number(exponentRaw);
  if (!Number.isInteger(exponent))
    throw new Error(`Invalid decimal value: ${value}`);

  const negative = coefficient.startsWith("-");
  const unsigned = coefficient.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  const digits = `${whole}${fraction}`;
  const decimalIndex = whole.length + exponent;

  let expanded: string;
  if (decimalIndex <= 0) {
    expanded = `0.${"0".repeat(Math.abs(decimalIndex))}${digits}`;
  } else if (decimalIndex >= digits.length) {
    expanded = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  } else {
    expanded = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  }

  return `${negative ? "-" : ""}${expanded}`;
}
