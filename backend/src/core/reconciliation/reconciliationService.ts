import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  type Abi,
  type Address,
} from "viem";
import type { AppConfig } from "../../config.js";
import type {
  HexAddress,
  ReconciliationReport,
  ReconciliationStatus,
} from "../../types/domain.js";
import { fromMicroUsdc, roundMoney } from "../money/money.js";
import {
  hasUsableVaultDeployment,
  loadContractsConfig,
} from "../../utils/contracts.js";
import type { Ledger } from "../storage/gatewayLedger.js";
import type { MarketDataService } from "../../examples/trading/marketData.js";

const MONEY_TOLERANCE = 0.000001;

export class ReconciliationService {
  constructor(
    private readonly ledger: Ledger,
    private readonly marketData: MarketDataService,
    private readonly appConfig: AppConfig,
  ) {}

  async reconcileUser(userAddress: HexAddress): Promise<ReconciliationReport> {
    const normalizedUser = getAddress(userAddress) as HexAddress;
    const portfolio = this.ledger.snapshot(
      normalizedUser,
      (symbol) => this.marketData.getQuote(symbol).price,
      this.appConfig.maxLeverage,
    );
    const onChain = await this.readOnChainState(normalizedUser);

    const detectedIssues: string[] = [];
    let status: ReconciliationStatus = "OK";

    if (!onChain.available) {
      detectedIssues.push("ONCHAIN_STATE_UNAVAILABLE");
      status = "WARNING";
    } else {
      if (!sameMoney(onChain.balance, portfolio.collateral)) {
        detectedIssues.push("BALANCE_MISMATCH");
        status = "MISMATCH";
      }

      if (
        !sameMoney(onChain.pendingWithdrawals, portfolio.pendingWithdrawals)
      ) {
        detectedIssues.push("PENDING_WITHDRAWAL_MISMATCH");
        status = "MISMATCH";
      }
    }

    if (Math.abs(portfolio.pendingSettlementPnl) >= MONEY_TOLERANCE) {
      detectedIssues.push("PENDING_REALIZED_PNL");
      if (status === "OK") status = "WARNING";
    }

    if (portfolio.positions.some((position) => position.quantity !== 0)) {
      detectedIssues.push("OPEN_POSITION");
      if (status === "OK") status = "WARNING";
    }

    if (portfolio.pendingWithdrawals > MONEY_TOLERANCE) {
      detectedIssues.push("PENDING_WITHDRAWAL");
      if (status === "OK") status = "WARNING";
    }

    return {
      userAddress: normalizedUser,
      onChainBalance: onChain.available ? roundMoney(onChain.balance) : null,
      offChainBalance: roundMoney(portfolio.collateral),
      pendingRealizedPnl: roundMoney(portfolio.pendingSettlementPnl),
      openPosition: portfolio.positions.some(
        (position) => position.quantity !== 0,
      ),
      openPositions: portfolio.positions.filter(
        (position) => position.quantity !== 0,
      ),
      pendingWithdraw: roundMoney(portfolio.pendingWithdrawals),
      onChainPendingWithdraw: onChain.available
        ? roundMoney(onChain.pendingWithdrawals)
        : null,
      offChainPendingWithdraw: roundMoney(portfolio.pendingWithdrawals),
      settlementHistory: portfolio.settlements,
      status,
      detectedIssues,
      ts: new Date().toISOString(),
    };
  }

  async reconcileAll(): Promise<{
    status: ReconciliationStatus;
    reports: ReconciliationReport[];
    detectedIssues: string[];
    ts: string;
  }> {
    const reports = await Promise.all(
      this.ledger
        .listKnownUsers()
        .map((userAddress) => this.reconcileUser(userAddress)),
    );
    const status = aggregateStatus(reports.map((report) => report.status));
    return {
      status,
      reports,
      detectedIssues: reports.flatMap((report) =>
        report.detectedIssues.map((issue) => `${report.userAddress}:${issue}`),
      ),
      ts: new Date().toISOString(),
    };
  }

  private async readOnChainState(
    userAddress: HexAddress,
  ): Promise<
    | { available: true; balance: number; pendingWithdrawals: number }
    | { available: false; balance: null; pendingWithdrawals: null }
  > {
    try {
      const contracts = await loadContractsConfig(this.appConfig.contractsFile);
      if (!hasUsableVaultDeployment(contracts)) {
        return { available: false, balance: null, pendingWithdrawals: null };
      }

      const vaultAddress = getAddress(
        contracts.collateralVault.address as Address,
      );
      const vaultAbi = contracts.collateralVault.abi as Abi;
      const chain = defineChain({
        id: this.appConfig.chainId,
        name: contracts.network ?? "Local Hardhat",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [this.appConfig.rpcUrl] } },
      });
      const publicClient = createPublicClient({
        chain,
        transport: http(this.appConfig.rpcUrl),
      });

      const [balance, pendingWithdrawals] = await Promise.all([
        publicClient.readContract({
          address: vaultAddress,
          abi: vaultAbi,
          functionName: "balanceOf",
          args: [userAddress],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: vaultAddress,
          abi: vaultAbi,
          functionName: "pendingWithdrawals",
          args: [userAddress],
        }) as Promise<bigint>,
      ]);

      return {
        available: true,
        balance: fromMicroUsdc(balance),
        pendingWithdrawals: fromMicroUsdc(pendingWithdrawals),
      };
    } catch {
      return { available: false, balance: null, pendingWithdrawals: null };
    }
  }
}

function sameMoney(left: number, right: number): boolean {
  return Math.abs(roundMoney(left) - roundMoney(right)) < MONEY_TOLERANCE;
}

function aggregateStatus(
  statuses: ReconciliationStatus[],
): ReconciliationStatus {
  if (statuses.includes("MISMATCH")) return "MISMATCH";
  if (statuses.includes("WARNING")) return "WARNING";
  return "OK";
}
