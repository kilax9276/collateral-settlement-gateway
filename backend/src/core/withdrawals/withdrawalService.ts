import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseEventLogs,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "../../config.js";
import type {
  HexAddress,
  IndexedChainEvent,
  WithdrawalRecord,
  WithdrawalResult,
} from "../../types/domain.js";
import { fromMicroUsdc, roundMoney, toMicroUsdc } from "../money/money.js";
import { conflict } from "../../utils/errors.js";
import {
  hasUsableVaultDeployment,
  loadContractsConfig,
} from "../../utils/contracts.js";
import type { ContractsConfig } from "../../types/contracts.js";
import type { Ledger } from "../storage/gatewayLedger.js";
import type { MarketDataService } from "../../examples/trading/marketData.js";
import type { RiskService } from "../risk/riskService.js";
import type { StoredSignedIntent } from "../storage/index.js";
import {
  COLLATERAL_GATEWAY_APP_ID,
  WITHDRAWAL_REQUEST_INTENT_TYPE,
  hashWithdrawalRequestPayload,
} from "../auth/signedIntentService.js";

const LOCAL_HARDHAT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

type WithdrawalLogger = {
  info: (message: string) => void;
};

export class WithdrawalService {
  constructor(
    private readonly ledger: Ledger,
    private readonly marketData: MarketDataService,
    private readonly riskService: RiskService,
    private readonly appConfig: AppConfig,
    private readonly logger: WithdrawalLogger = console,
  ) {}

  async requestWithdrawal(
    userAddress: HexAddress,
    amount: number,
    signedIntentId: string,
  ): Promise<WithdrawalResult> {
    const normalizedAmount = roundMoney(amount);
    const normalizedUserAddress = getAddress(userAddress) as HexAddress;
    const intent = this.validateWithdrawalIntentBasics(
      normalizedUserAddress,
      signedIntentId,
    );
    this.ledger.assertWithdrawalRequestAllowed(
      normalizedUserAddress,
      normalizedAmount,
    );

    const contracts = await this.loadUsableContracts();
    const vaultAddress = getAddress(
      contracts.collateralVault.address as Address,
    );
    this.validateWithdrawalIntentPayload(
      intent,
      normalizedUserAddress,
      normalizedAmount,
      vaultAddress,
    );
    const vaultAbi = contracts.collateralVault.abi as Abi;
    const { publicClient, walletClient, operatorAddress, operatorAccount } =
      this.createClients(contracts);
    this.assertExpectedOperator(contracts, operatorAddress);

    const txHash = await walletClient.writeContract({
      address: vaultAddress,
      abi: vaultAbi,
      functionName: "requestWithdrawFor",
      args: [normalizedUserAddress, toMicroUsdc(normalizedAmount)],
      account: operatorAccount,
      chain: null,
    });

    this.logger.info(
      `Withdrawal request tx submitted for ${normalizedUserAddress}: amount=${normalizedAmount}, signedIntentId=${signedIntentId}, txHash=${txHash}`,
    );

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });
    if (receipt.status !== "success") {
      throw conflict(
        "WITHDRAW_REQUEST_TX_REVERTED",
        `Withdrawal request reverted: ${txHash}`,
      );
    }

    const event = parseWithdrawalEvent(
      vaultAbi,
      receipt.logs,
      "WithdrawRequested",
      normalizedUserAddress,
    );
    if (!event) {
      throw conflict(
        "WITHDRAW_REQUEST_EVENT_NOT_FOUND",
        "WithdrawRequested event was not found",
      );
    }

    const indexedEvent = toIndexedWithdrawalEvent(
      "WithdrawRequested",
      txHash,
      event,
    );
    const shouldApply = indexedEvent
      ? this.ledger.recordIndexedChainEvent(indexedEvent)
      : true;
    if (shouldApply)
      this.ledger.applyIndexedWithdrawRequest(event.userAddress, event.amount);

    const withdrawal: WithdrawalRecord = {
      withdrawalId: `request_${txHash}`,
      userAddress: event.userAddress,
      amount: event.amount,
      status: "ONCHAIN_REQUESTED",
      txHash,
      ts: new Date().toISOString(),
    };

    this.ledger.consumeSignedIntents(txHash as HexAddress, [signedIntentId]);

    return { withdrawal, portfolio: this.snapshot(normalizedUserAddress) };
  }

  async approveWithdrawal(
    userAddress: HexAddress,
    amount: number,
  ): Promise<WithdrawalResult> {
    const normalizedUserAddress = getAddress(userAddress) as HexAddress;
    const normalizedAmount = roundMoney(amount);
    this.riskService.checkWithdrawAllowed(
      normalizedUserAddress,
      normalizedAmount,
    );

    const contracts = await this.loadUsableContracts();
    const vaultAddress = getAddress(
      contracts.collateralVault.address as Address,
    );
    const vaultAbi = contracts.collateralVault.abi as Abi;
    const { publicClient, walletClient, operatorAddress, operatorAccount } =
      this.createClients(contracts);
    this.assertExpectedOperator(contracts, operatorAddress);

    const txHash = await walletClient.writeContract({
      address: vaultAddress,
      abi: vaultAbi,
      functionName: "approveWithdraw",
      args: [normalizedUserAddress, toMicroUsdc(normalizedAmount)],
      account: operatorAccount,
      chain: null,
    });

    this.logger.info(
      `Withdrawal approval tx submitted for ${userAddress}: amount=${normalizedAmount}, txHash=${txHash}`,
    );

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });
    if (receipt.status !== "success") {
      throw conflict(
        "WITHDRAW_APPROVAL_TX_REVERTED",
        `Withdrawal approval reverted: ${txHash}`,
      );
    }

    const event = parseWithdrawalEvent(
      vaultAbi,
      receipt.logs,
      "WithdrawApproved",
      normalizedUserAddress,
    );
    if (!event) {
      throw conflict(
        "WITHDRAW_APPROVAL_EVENT_NOT_FOUND",
        "WithdrawApproved event was not found",
      );
    }

    const indexedEvent = toIndexedWithdrawalEvent(
      "WithdrawApproved",
      txHash,
      event,
    );
    const shouldApply = indexedEvent
      ? this.ledger.recordIndexedChainEvent(indexedEvent)
      : true;
    if (shouldApply)
      this.ledger.applyIndexedWithdrawApproval(event.userAddress, event.amount);

    const withdrawal: WithdrawalRecord = {
      withdrawalId: `approval_${txHash}`,
      userAddress: event.userAddress,
      amount: event.amount,
      status: "ONCHAIN_APPROVED",
      txHash,
      ts: new Date().toISOString(),
    };

    return { withdrawal, portfolio: this.snapshot(normalizedUserAddress) };
  }

  private validateWithdrawalIntentBasics(
    userAddress: HexAddress,
    signedIntentId: string,
  ): StoredSignedIntent {
    const intent = this.ledger.getSignedIntentById(signedIntentId);
    if (!intent) {
      throw conflict(
        "WITHDRAWAL_INTENT_NOT_FOUND",
        `Signed withdrawal intent not found: ${signedIntentId}`,
      );
    }

    if (intent.status === "CONSUMED") {
      throw conflict(
        "WITHDRAWAL_INTENT_ALREADY_CONSUMED",
        `Signed withdrawal intent has already been consumed: ${signedIntentId}`,
      );
    }

    if (intent.status === "EXPIRED") {
      throw conflict(
        "WITHDRAWAL_INTENT_EXPIRED",
        `Signed withdrawal intent is expired: ${signedIntentId}`,
      );
    }

    if (intent.status !== "VERIFIED") {
      throw conflict(
        "WITHDRAWAL_INTENT_NOT_VERIFIED",
        `Signed withdrawal intent is not verified: ${signedIntentId}`,
      );
    }

    if (intent.appId !== COLLATERAL_GATEWAY_APP_ID) {
      throw conflict(
        "WITHDRAWAL_INTENT_APP_MISMATCH",
        `Withdrawal intents must use appId=${COLLATERAL_GATEWAY_APP_ID}`,
      );
    }

    if (intent.intentType !== WITHDRAWAL_REQUEST_INTENT_TYPE) {
      throw conflict(
        "WITHDRAWAL_INTENT_TYPE_MISMATCH",
        `Withdrawal intent must use intentType=${WITHDRAWAL_REQUEST_INTENT_TYPE}`,
      );
    }

    if (getAddress(intent.userAddress) !== getAddress(userAddress)) {
      throw conflict(
        "WITHDRAWAL_INTENT_USER_MISMATCH",
        "Signed withdrawal intent belongs to a different userAddress",
      );
    }

    const now = Math.floor(Date.now() / 1000);
    if (intent.deadline < now) {
      this.ledger.expireSignedIntent(intent.id);
      throw conflict(
        "WITHDRAWAL_INTENT_EXPIRED",
        `Signed withdrawal intent deadline has passed: ${signedIntentId}`,
      );
    }

    return intent;
  }

  private validateWithdrawalIntentPayload(
    intent: StoredSignedIntent,
    userAddress: HexAddress,
    amount: number,
    vaultAddress: Address,
  ): void {
    const expectedPayloadHash = hashWithdrawalRequestPayload({
      userAddress,
      amount,
      chainId: this.appConfig.chainId,
      vaultAddress,
    });

    if (
      intent.payloadHash.toLowerCase() !== expectedPayloadHash.toLowerCase()
    ) {
      throw conflict(
        "WITHDRAWAL_INTENT_PAYLOAD_HASH_MISMATCH",
        "Signed withdrawal intent payloadHash does not match userAddress, amount, chainId and Vault address",
      );
    }
  }

  private snapshot(userAddress: HexAddress): WithdrawalResult["portfolio"] {
    return this.ledger.snapshot(
      userAddress,
      (symbol) => this.marketData.getQuote(symbol).price,
      this.appConfig.maxLeverage,
    );
  }

  private async loadUsableContracts(): Promise<ContractsConfig> {
    const contracts = await loadContractsConfig(this.appConfig.contractsFile);
    if (!hasUsableVaultDeployment(contracts)) {
      throw conflict(
        "CONTRACT_DEPLOYMENT_NOT_READY",
        `${this.appConfig.contractsFile} does not contain a deployed CollateralVault address and ABI yet. Run npm run deploy:local first.`,
      );
    }
    return contracts;
  }

  private createClients(contracts: ContractsConfig): {
    publicClient: PublicClient;
    walletClient: WalletClient;
    operatorAddress: Address;
    operatorAccount: Account;
  } {
    const privateKey = resolveOperatorPrivateKey(
      this.appConfig.operatorPrivateKey,
    );
    const account = privateKeyToAccount(privateKey);
    const operatorAddress = getAddress(account.address);

    const chain = defineChain({
      id: this.appConfig.chainId,
      name: contracts.network ?? "Local Hardhat",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [this.appConfig.rpcUrl] } },
    });

    const transport = http(this.appConfig.rpcUrl);
    return {
      publicClient: createPublicClient({ chain, transport }),
      walletClient: createWalletClient({ account, chain, transport }),
      operatorAddress,
      operatorAccount: account,
    };
  }

  private assertExpectedOperator(
    contracts: ContractsConfig,
    operatorAddress: Address,
  ): void {
    const expectedOperator = contracts.operator
      ? getAddress(contracts.operator)
      : null;
    if (expectedOperator && expectedOperator !== operatorAddress) {
      throw conflict(
        "OPERATOR_MISMATCH",
        `OPERATOR_PRIVATE_KEY resolves to ${operatorAddress}, but deployed Vault operator is ${expectedOperator}`,
      );
    }
  }
}

type ParsedWithdrawalEvent = {
  userAddress: Address;
  amount: number;
  eventId?: string;
};

function parseWithdrawalEvent(
  abi: Abi,
  logs: readonly unknown[],
  eventName: "WithdrawRequested" | "WithdrawApproved",
  targetUserAddress: HexAddress,
): ParsedWithdrawalEvent | null {
  const parsedLogs = parseEventLogs({
    abi,
    logs: logs as Parameters<typeof parseEventLogs>[0]["logs"],
    eventName,
  });

  const target = getAddress(targetUserAddress);
  for (const log of parsedLogs) {
    const args = log.args as { user?: Address; amount?: bigint };
    if (!args.user || typeof args.amount !== "bigint") continue;

    const userAddress = getAddress(args.user);
    if (userAddress !== target) continue;

    return {
      userAddress,
      amount: fromMicroUsdc(args.amount),
      eventId: eventIdFromParsedLog(log),
    };
  }

  return null;
}

function toIndexedWithdrawalEvent(
  type: "WithdrawRequested" | "WithdrawApproved",
  txHash: string,
  event: ParsedWithdrawalEvent,
): IndexedChainEvent | null {
  if (!event.eventId) return null;
  const [, rawLogIndex] = event.eventId.split(":");
  return {
    eventId: event.eventId,
    type,
    userAddress: event.userAddress,
    amount: event.amount,
    txHash,
    logIndex: rawLogIndex ? Number(rawLogIndex) : undefined,
    ts: new Date().toISOString(),
  };
}

function eventIdFromParsedLog(log: unknown): string | undefined {
  const maybeLog = log as { transactionHash?: string; logIndex?: number };
  if (!maybeLog.transactionHash || typeof maybeLog.logIndex !== "number")
    return undefined;
  return `${maybeLog.transactionHash}:${maybeLog.logIndex}`;
}

function resolveOperatorPrivateKey(rawPrivateKey: string | null): Hex {
  const privateKey = rawPrivateKey?.trim() || LOCAL_HARDHAT_PRIVATE_KEY;
  const normalized = privateKey.startsWith("0x")
    ? privateKey
    : `0x${privateKey}`;
  return normalized as Hex;
}
