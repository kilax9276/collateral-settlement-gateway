import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  type Abi,
  type Address,
  type PublicClient,
  type Hash,
  type Hex,
} from "viem";
import type { AppConfig } from "../../config.js";
import type { IndexedChainEvent } from "../../types/domain.js";
import { fromMicroUsdc } from "../money/money.js";
import {
  hasUsableVaultDeployment,
  loadContractsConfig,
} from "../../utils/contracts.js";
import type { Ledger } from "../storage/gatewayLedger.js";
import type { MarketDataService } from "../../examples/trading/marketData.js";

export type RealtimePublisher = (event: {
  type: string;
  payload: unknown;
}) => void;

export type IndexerLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string | Error) => void;
};

type DecodedContractLog = {
  eventName?: string;
  args?: Record<string, unknown>;
  transactionHash?: Hash;
  logIndex?: number;
  blockNumber?: bigint;
};

export class BlockchainIndexer {
  private publicClient?: PublicClient;
  private unwatch?: () => void;
  private started = false;
  private vaultAddress?: Address;
  private readonly seenLogs = new Set<string>();

  constructor(
    private readonly ledger: Ledger,
    private readonly marketData: MarketDataService,
    private readonly appConfig: AppConfig,
    private readonly publish: RealtimePublisher,
    private readonly logger: IndexerLogger = console,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;

    if (!this.appConfig.indexerEnabled) {
      this.logger.info(
        "Blockchain indexer is disabled by INDEXER_ENABLED=false",
      );
      return;
    }

    const contracts = await loadContractsConfig(this.appConfig.contractsFile);
    if (!hasUsableVaultDeployment(contracts)) {
      this.logger.warn(
        `Blockchain indexer skipped: ${this.appConfig.contractsFile} does not contain a deployed CollateralVault address and ABI yet.`,
      );
      return;
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
    this.publicClient = publicClient;

    const rpcChainId = await publicClient.getChainId();
    if (rpcChainId !== this.appConfig.chainId) {
      this.logger.warn(
        `Blockchain indexer connected to chainId=${rpcChainId}, while CHAIN_ID=${this.appConfig.chainId}`,
      );
    }

    this.vaultAddress = vaultAddress;
    const storedCursor = this.ledger.getIndexerCursor(
      this.appConfig.chainId,
      vaultAddress,
    );
    const fromBlock = storedCursor
      ? BigInt(storedCursor) + 1n
      : deploymentBlockToBigInt(contracts.deploymentBlock);
    await this.syncHistoricalEvents(vaultAddress, vaultAbi, fromBlock);

    this.unwatch = publicClient.watchContractEvent({
      address: vaultAddress,
      abi: vaultAbi,
      pollingInterval: this.appConfig.indexerPollIntervalMs,
      onLogs: (logs) => {
        void this.processLogs(logs as DecodedContractLog[]);
      },
      onError: (error) => {
        this.logger.error(
          error instanceof Error ? error : new Error(String(error)),
        );
      },
    });

    this.started = true;
    this.logger.info(
      `Blockchain indexer started for CollateralVault ${vaultAddress}`,
    );
  }

  async stop(): Promise<void> {
    this.unwatch?.();
    this.unwatch = undefined;
    this.started = false;
  }

  status(): {
    enabled: boolean;
    started: boolean;
    vaultAddress: Address | null;
    lastProcessedBlock: string | null;
  } {
    const vaultAddress = this.vaultAddress ?? null;
    return {
      enabled: this.appConfig.indexerEnabled,
      started: this.started,
      vaultAddress,
      lastProcessedBlock: vaultAddress
        ? this.ledger.getIndexerCursor(this.appConfig.chainId, vaultAddress)
        : null,
    };
  }

  private async syncHistoricalEvents(
    vaultAddress: Address,
    vaultAbi: Abi,
    fromBlock: bigint,
  ) {
    if (!this.publicClient) return;

    const toBlock = await this.publicClient.getBlockNumber();
    if (toBlock < fromBlock) return;

    const logs = (await this.publicClient.getContractEvents({
      address: vaultAddress,
      abi: vaultAbi,
      fromBlock,
      toBlock,
    })) as DecodedContractLog[];

    await this.processLogs(logs);
    this.logger.info(
      `Blockchain indexer historical sync completed from block ${fromBlock.toString()} to ${toBlock.toString()}`,
    );
  }

  private async processLogs(logs: DecodedContractLog[]): Promise<void> {
    for (const log of logs) {
      try {
        this.processLog(log);
      } catch (error) {
        this.logger.error(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  private processLog(log: DecodedContractLog): void {
    const txHash = log.transactionHash;
    if (!txHash || typeof log.logIndex !== "number") return;

    const eventId = `${txHash}:${log.logIndex}`;
    if (this.seenLogs.has(eventId)) return;
    this.seenLogs.add(eventId);

    switch (log.eventName) {
      case "Deposited":
        this.handleDeposited(eventId, log);
        break;
      case "WithdrawRequested":
        this.handleWithdrawRequested(eventId, log);
        break;
      case "WithdrawApproved":
        this.handleWithdrawApproved(eventId, log);
        break;
      case "Withdrawn":
        this.handleWithdrawn(eventId, log);
        break;
      case "SettlementApplied":
        this.handleSettlementApplied(eventId, log);
        break;
      case "PnlSettled":
        this.handlePnlSettled(eventId, log);
        break;
      default:
        break;
    }
  }

  private handleDeposited(eventId: string, log: DecodedContractLog): void {
    const userAddress = readAddressArg(log, "user");
    const amount = fromMicroUsdc(readBigIntArg(log, "amount"));

    const event: IndexedChainEvent = {
      eventId,
      type: "Deposited",
      userAddress,
      amount,
      txHash: log.transactionHash as Hash,
      blockNumber: log.blockNumber?.toString(),
      logIndex: log.logIndex,
      ts: new Date().toISOString(),
    };
    if (!this.ledger.recordIndexedChainEvent(event)) return;
    this.ledger.applyIndexedDeposit(userAddress, amount);
    this.publishIndexedEvent(event);
    this.saveCursor(event);
  }

  private handleWithdrawRequested(
    eventId: string,
    log: DecodedContractLog,
  ): void {
    const userAddress = readAddressArg(log, "user");
    const amount = fromMicroUsdc(readBigIntArg(log, "amount"));

    const event: IndexedChainEvent = {
      eventId,
      type: "WithdrawRequested",
      userAddress,
      amount,
      txHash: log.transactionHash as Hash,
      blockNumber: log.blockNumber?.toString(),
      logIndex: log.logIndex,
      ts: new Date().toISOString(),
    };
    if (!this.ledger.recordIndexedChainEvent(event)) return;
    this.ledger.applyIndexedWithdrawRequest(userAddress, amount);
    this.publishIndexedEvent(event);
    this.saveCursor(event);
  }

  private handleWithdrawApproved(
    eventId: string,
    log: DecodedContractLog,
  ): void {
    const userAddress = readAddressArg(log, "user");
    const amount = fromMicroUsdc(readBigIntArg(log, "amount"));

    const event: IndexedChainEvent = {
      eventId,
      type: "WithdrawApproved",
      userAddress,
      amount,
      txHash: log.transactionHash as Hash,
      blockNumber: log.blockNumber?.toString(),
      logIndex: log.logIndex,
      ts: new Date().toISOString(),
    };
    if (!this.ledger.recordIndexedChainEvent(event)) return;
    this.ledger.applyIndexedWithdrawApproval(userAddress, amount);
    this.publishIndexedEvent(event);
    this.saveCursor(event);
  }

  private handleWithdrawn(eventId: string, log: DecodedContractLog): void {
    const userAddress = readAddressArg(log, "user");
    const amount = fromMicroUsdc(readBigIntArg(log, "amount"));

    const event: IndexedChainEvent = {
      eventId,
      type: "Withdrawn",
      userAddress,
      amount,
      txHash: log.transactionHash as Hash,
      blockNumber: log.blockNumber?.toString(),
      logIndex: log.logIndex,
      ts: new Date().toISOString(),
    };
    if (!this.ledger.recordIndexedChainEvent(event)) return;
    this.ledger.applyIndexedWithdraw(userAddress, amount);
    this.publishIndexedEvent(event);
    this.saveCursor(event);
  }

  private handleSettlementApplied(
    eventId: string,
    log: DecodedContractLog,
  ): void {
    const userAddress = readAddressArg(log, "user");
    const amountDelta = fromMicroUsdc(readBigIntArg(log, "amountDelta"));
    const newBalance = fromMicroUsdc(readBigIntArg(log, "newBalance"));
    const settlementId = readHexArg(log, "settlementId");
    const reasonHash = readHexArg(log, "reasonHash");

    const event: IndexedChainEvent = {
      eventId,
      type: "SettlementApplied",
      userAddress,
      amountDelta,
      pnl: amountDelta,
      newBalance,
      settlementId,
      reasonHash,
      txHash: log.transactionHash as Hash,
      blockNumber: log.blockNumber?.toString(),
      logIndex: log.logIndex,
      ts: new Date().toISOString(),
    };
    if (!this.ledger.recordIndexedChainEvent(event)) return;
    this.ledger.applyIndexedSettlement(
      userAddress,
      amountDelta,
      newBalance,
      log.transactionHash as Hash,
      undefined,
      settlementId,
      reasonHash,
      {
        blockNumber: log.blockNumber?.toString() ?? null,
        eventName: "SettlementApplied",
        contractAddress: this.vaultAddress ?? null,
      },
    );
    this.publishIndexedEvent(event);
    this.saveCursor(event);
  }

  private handlePnlSettled(eventId: string, log: DecodedContractLog): void {
    const userAddress = readAddressArg(log, "user");
    const pnl = fromMicroUsdc(readBigIntArg(log, "pnl"));
    const newBalance = fromMicroUsdc(readBigIntArg(log, "newBalance"));
    const settlementId = readHexArg(log, "settlementId");
    const reasonHash = readHexArg(log, "reasonHash");

    const event: IndexedChainEvent = {
      eventId,
      type: "PnlSettled",
      userAddress,
      amountDelta: pnl,
      pnl,
      newBalance,
      settlementId,
      reasonHash,
      txHash: log.transactionHash as Hash,
      blockNumber: log.blockNumber?.toString(),
      logIndex: log.logIndex,
      ts: new Date().toISOString(),
    };
    if (!this.ledger.recordIndexedChainEvent(event)) return;
    this.ledger.applyIndexedSettlement(
      userAddress,
      pnl,
      newBalance,
      log.transactionHash as Hash,
      undefined,
      settlementId,
      reasonHash,
      {
        blockNumber: log.blockNumber?.toString() ?? null,
        eventName: "PnlSettled",
        contractAddress: this.vaultAddress ?? null,
      },
    );
    this.publishIndexedEvent(event);
    this.saveCursor(event);
  }

  private saveCursor(event: IndexedChainEvent): void {
    if (!this.vaultAddress || !event.blockNumber) return;
    this.ledger.saveIndexerCursor(
      this.appConfig.chainId,
      this.vaultAddress,
      event.blockNumber,
    );
  }

  private publishIndexedEvent(event: IndexedChainEvent): void {
    const eventTypeByName = {
      Deposited: "chain:deposited",
      WithdrawRequested: "chain:withdraw_requested",
      WithdrawApproved: "chain:withdraw_approved",
      Withdrawn: "chain:withdrawn",
      SettlementApplied: "settlement:confirmed",
      PnlSettled: "settlement:confirmed",
    } as const;

    this.publish({ type: eventTypeByName[event.type], payload: event });

    const portfolio = this.ledger.snapshot(
      event.userAddress,
      (symbol) => this.marketData.getQuote(symbol).price,
      this.appConfig.maxLeverage,
    );
    this.publish({ type: "portfolio:updated", payload: portfolio });
  }
}

function deploymentBlockToBigInt(
  value: string | number | bigint | null | undefined,
): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.max(0, value));
  if (typeof value === "string" && value.trim()) return BigInt(value);
  return 0n;
}

function readAddressArg(log: DecodedContractLog, name: string): Address {
  const value = log.args?.[name];
  if (typeof value !== "string") {
    throw new Error(`Missing address event arg: ${name}`);
  }
  return getAddress(value);
}

function readHexArg(log: DecodedContractLog, name: string): Hex {
  const value = log.args?.[name];
  if (typeof value === "string" && value.startsWith("0x")) return value as Hex;
  throw new Error(`Missing bytes32 event arg: ${name}`);
}

function readBigIntArg(log: DecodedContractLog, name: string): bigint {
  const value = log.args?.[name];
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string" && value.trim()) return BigInt(value);
  throw new Error(`Missing bigint event arg: ${name}`);
}
