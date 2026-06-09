import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  parseEther,
  parseUnits,
  type Abi,
  type Account,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "../config.js";
import type { ContractsConfig } from "../types/contracts.js";
import type {
  HexAddress,
  OrderResult,
  Portfolio,
  Quote,
  SettlementResult,
  WithdrawalResult,
} from "../types/domain.js";
import { conflict } from "../utils/errors.js";
import {
  hasUsableVaultDeployment,
  loadContractsConfig,
} from "../utils/contracts.js";
import { roundMoney } from "../core/money/money.js";
import {
  buildSignedIntentTypedData,
  buildTradingOrderIntent,
  buildWithdrawalRequestIntent,
} from "../core/auth/signedIntentService.js";
import type { Ledger } from "../core/storage/gatewayLedger.js";
import type { MarketDataService } from "../examples/trading/marketData.js";
import type { SignedIntentService } from "../core/auth/signedIntentService.js";
import type { SettlementService } from "../core/settlement/settlementService.js";
import type { TradingEngine } from "../examples/trading/tradingEngine.js";
import type { WithdrawalService } from "../core/withdrawals/withdrawalService.js";

const LOCAL_HARDHAT_OPERATOR_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const LOCAL_HARDHAT_MNEMONIC =
  "test test test test test test test test test test test junk";
const DEFAULT_DEMO_DEPOSIT_USDC = 10_000;
const DEFAULT_DEMO_INSURANCE_USDC = 500;
const DEFAULT_DEMO_POSITION_BTC = 0.05;
const DEFAULT_DEMO_PRICE_UP = 67_000;

export type DemoActionResult = {
  action: string;
  message: string;
  txHash?: string;
  order?: OrderResult["order"];
  trade?: OrderResult["trade"];
  settlement?: SettlementResult["settlement"];
  withdrawal?: WithdrawalResult["withdrawal"];
  state: DemoState;
};

export type DemoState = {
  demoOnly: true;
  selectedWallet: HexAddress;
  operatorAddress: HexAddress;
  contracts: {
    chainId: number;
    mockUSDC: HexAddress | null;
    collateralVault: HexAddress | null;
  };
  balances: {
    walletTokenBalance: number | null;
    onChainVaultBalance: number | null;
    backendCollateral: number;
    insuranceBalance: number | null;
    approvedAllowance: number | null;
  };
  market: Quote;
  portfolio: Portfolio;
  eventFeedHint: string;
  ts: string;
};

type LoadedContracts = ContractsConfig & {
  mockUSDC: { address: Address; abi: Abi };
  collateralVault: { address: Address; abi: Abi };
};

export class DemoService {
  constructor(
    private readonly ledger: Ledger,
    private readonly marketData: MarketDataService,
    private readonly signedIntentService: SignedIntentService,
    private readonly tradingEngine: TradingEngine,
    private readonly settlementService: SettlementService,
    private readonly withdrawalService: WithdrawalService,
    private readonly appConfig: AppConfig,
  ) {}

  async getState(): Promise<DemoState> {
    const contracts = await this.tryLoadContracts();
    const alice = this.aliceAccount();
    const operator = this.operatorAccount();
    const portfolio = this.snapshot(alice.address as HexAddress);
    const quote = this.marketData.getQuote(this.appConfig.defaultSymbol);

    let walletTokenBalance: number | null = null;
    let onChainVaultBalance: number | null = null;
    let insuranceBalance: number | null = null;
    let approvedAllowance: number | null = null;

    if (contracts) {
      const publicClient = this.publicClient(contracts);
      const [tokenBalance, vaultBalance, insurance, allowance] =
        await Promise.all([
          publicClient.readContract({
            address: contracts.mockUSDC.address,
            abi: contracts.mockUSDC.abi,
            functionName: "balanceOf",
            args: [alice.address],
          }) as Promise<bigint>,
          publicClient.readContract({
            address: contracts.collateralVault.address,
            abi: contracts.collateralVault.abi,
            functionName: "balanceOf",
            args: [alice.address],
          }) as Promise<bigint>,
          publicClient.readContract({
            address: contracts.collateralVault.address,
            abi: contracts.collateralVault.abi,
            functionName: "insuranceBalance",
          }) as Promise<bigint>,
          publicClient.readContract({
            address: contracts.mockUSDC.address,
            abi: contracts.mockUSDC.abi,
            functionName: "allowance",
            args: [alice.address, contracts.collateralVault.address],
          }) as Promise<bigint>,
        ]);
      walletTokenBalance = fromUsdc(tokenBalance);
      onChainVaultBalance = fromUsdc(vaultBalance);
      insuranceBalance = fromUsdc(insurance);
      approvedAllowance = fromUsdc(allowance);
    }

    return {
      demoOnly: true,
      selectedWallet: getAddress(alice.address) as HexAddress,
      operatorAddress: getAddress(operator.address) as HexAddress,
      contracts: {
        chainId: this.appConfig.chainId,
        mockUSDC: contracts?.mockUSDC.address ?? null,
        collateralVault: contracts?.collateralVault.address ?? null,
      },
      balances: {
        walletTokenBalance,
        onChainVaultBalance,
        backendCollateral: portfolio.collateral,
        insuranceBalance,
        approvedAllowance,
      },
      market: quote,
      portfolio,
      eventFeedHint:
        "Live events are streamed from ws://localhost:3000/ws in local demos.",
      ts: new Date().toISOString(),
    };
  }

  async mintDemoUsdc(): Promise<DemoActionResult> {
    const contracts = await this.loadContractsOrThrow();
    const operator = this.operatorAccount();
    const alice = this.aliceAccount();
    await this.ensureAliceHasGas(contracts, alice);

    const walletClient = this.operatorWallet(contracts, operator);
    const publicClient = this.publicClient(contracts);

    await this.waitForSuccess(
      publicClient,
      await walletClient.writeContract({
        address: contracts.mockUSDC.address,
        abi: contracts.mockUSDC.abi,
        functionName: "mint",
        args: [alice.address, parseUsdc(DEFAULT_DEMO_DEPOSIT_USDC)],
      }),
    );

    await this.waitForSuccess(
      publicClient,
      await walletClient.writeContract({
        address: contracts.mockUSDC.address,
        abi: contracts.mockUSDC.abi,
        functionName: "mint",
        args: [operator.address, parseUsdc(DEFAULT_DEMO_INSURANCE_USDC)],
      }),
    );

    await this.waitForSuccess(
      publicClient,
      await walletClient.writeContract({
        address: contracts.mockUSDC.address,
        abi: contracts.mockUSDC.abi,
        functionName: "approve",
        args: [
          contracts.collateralVault.address,
          parseUsdc(DEFAULT_DEMO_INSURANCE_USDC),
        ],
      }),
    );

    const txHash = await walletClient.writeContract({
      address: contracts.collateralVault.address,
      abi: contracts.collateralVault.abi,
      functionName: "fundInsurance",
      args: [parseUsdc(DEFAULT_DEMO_INSURANCE_USDC)],
    });
    await this.waitForSuccess(publicClient, txHash);

    return this.actionResult(
      "mint-demo-usdc",
      `Minted ${DEFAULT_DEMO_DEPOSIT_USDC} mUSDC to Alice and funded ${DEFAULT_DEMO_INSURANCE_USDC} mUSDC insurance liquidity.`,
      { txHash },
    );
  }

  async approveVault(): Promise<DemoActionResult> {
    const contracts = await this.loadContractsOrThrow();
    const alice = this.aliceAccount();
    const publicClient = this.publicClient(contracts);
    await this.ensureAliceHasGas(contracts, alice);
    const walletClient = this.aliceWallet(contracts, alice);
    const txHash = await walletClient.writeContract({
      address: contracts.mockUSDC.address,
      abi: contracts.mockUSDC.abi,
      functionName: "approve",
      args: [
        contracts.collateralVault.address,
        parseUsdc(DEFAULT_DEMO_DEPOSIT_USDC),
      ],
    });
    await this.waitForSuccess(publicClient, txHash);

    return this.actionResult(
      "approve",
      `Approved Vault to spend ${DEFAULT_DEMO_DEPOSIT_USDC} mUSDC from the demo wallet.`,
      { txHash },
    );
  }

  async deposit(): Promise<DemoActionResult> {
    const contracts = await this.loadContractsOrThrow();
    const alice = this.aliceAccount();
    const publicClient = this.publicClient(contracts);
    await this.ensureAliceHasGas(contracts, alice);
    const walletClient = this.aliceWallet(contracts, alice);
    const tokenBalance = (await publicClient.readContract({
      address: contracts.mockUSDC.address,
      abi: contracts.mockUSDC.abi,
      functionName: "balanceOf",
      args: [alice.address],
    })) as bigint;
    const amount =
      tokenBalance >= parseUsdc(DEFAULT_DEMO_DEPOSIT_USDC)
        ? parseUsdc(DEFAULT_DEMO_DEPOSIT_USDC)
        : tokenBalance;
    if (amount <= 0n) {
      throw conflict("DEMO_NO_TOKEN_BALANCE", "Mint demo USDC before deposit");
    }

    const txHash = await walletClient.writeContract({
      address: contracts.collateralVault.address,
      abi: contracts.collateralVault.abi,
      functionName: "deposit",
      args: [amount],
    });
    await this.waitForSuccess(publicClient, txHash);

    return this.actionResult(
      "deposit",
      `Deposited ${fromUsdc(amount)} mUSDC into the Vault.`,
      {
        txHash,
      },
    );
  }

  async openLong(): Promise<DemoActionResult> {
    const result = await this.placeSignedDemoOrder(
      "BUY",
      DEFAULT_DEMO_POSITION_BTC,
      `dashboard-buy-${Date.now()}`,
    );
    return this.actionResult(
      "open-long",
      "Opened a BTC-USD long through a signed EIP-712 order.",
      {
        order: result.order,
        trade: result.trade,
      },
    );
  }

  async movePriceUp(): Promise<DemoActionResult> {
    const quote = this.marketData.setPrice(
      this.appConfig.defaultSymbol,
      DEFAULT_DEMO_PRICE_UP,
    );
    return this.actionResult(
      "move-price",
      `Moved ${quote.symbol} mock price to ${quote.price}.`,
    );
  }

  async closePosition(): Promise<DemoActionResult> {
    const state = this.ledger.getOrCreate(
      this.aliceAccount().address as HexAddress,
    );
    const position = state.positions.get(
      this.appConfig.defaultSymbol.toUpperCase(),
    );
    if (!position || position.quantity <= 0) {
      throw conflict(
        "DEMO_NO_OPEN_POSITION",
        "Open a long position before closing it",
      );
    }

    const result = await this.placeSignedDemoOrder(
      "SELL",
      position.quantity,
      `dashboard-sell-${Date.now()}`,
    );
    return this.actionResult(
      "close-position",
      "Closed the demo BTC-USD long position.",
      {
        order: result.order,
        trade: result.trade,
      },
    );
  }

  async settle(): Promise<DemoActionResult> {
    const alice = this.aliceAccount().address as HexAddress;
    const result = await this.settlementService.settleUser(alice);
    return this.actionResult(
      "settle",
      "Settled pending realized P&L through the generic settlement API.",
      {
        settlement: result.settlement,
      },
    );
  }

  async requestWithdraw(): Promise<DemoActionResult> {
    const contracts = await this.loadContractsOrThrow();
    const alice = this.aliceAccount();
    const userAddress = getAddress(alice.address) as HexAddress;
    const amount = await this.withdrawableAmount();
    const nonce = this.signedIntentService.issueNonce(userAddress);
    const intent = buildWithdrawalRequestIntent({
      userAddress,
      amount,
      chainId: this.appConfig.chainId,
      vaultAddress: contracts.collateralVault.address,
      nonce: nonce.nonce,
      deadline: Math.floor(Date.now() / 1000) + 300,
    });
    const signature = await alice.signTypedData!(
      buildSignedIntentTypedData({
        chainId: this.appConfig.chainId,
        verifyingContract: contracts.collateralVault.address,
        intent,
      }),
    );
    const verifiedIntent = await this.signedIntentService.verifySignedIntent(
      intent,
      signature,
      {
        consumeNonce: true,
        expectedAppId: intent.appId,
        expectedIntentType: intent.intentType,
        expectedPayloadHash: intent.payloadHash,
      },
    );
    const result = await this.withdrawalService.requestWithdrawal(
      userAddress,
      amount,
      verifiedIntent.intentId,
    );
    return this.actionResult(
      "request-withdraw",
      `Requested withdrawal for ${amount} mUSDC with signed intent ${verifiedIntent.intentId}.`,
      {
        withdrawal: result.withdrawal,
      },
    );
  }

  async approveWithdraw(): Promise<DemoActionResult> {
    const alice = this.aliceAccount().address as HexAddress;
    const state = this.ledger.getOrCreate(alice);
    const amount = roundMoney(state.pendingWithdrawals);
    if (amount <= 0)
      throw conflict("DEMO_NO_PENDING_WITHDRAWAL", "Request withdrawal first");

    const result = await this.withdrawalService.approveWithdrawal(
      alice,
      amount,
    );
    return this.actionResult(
      "approve-withdraw",
      `Approved withdrawal for ${amount} mUSDC.`,
      {
        withdrawal: result.withdrawal,
      },
    );
  }

  async withdraw(): Promise<DemoActionResult> {
    const contracts = await this.loadContractsOrThrow();
    const alice = this.aliceAccount();
    const state = this.ledger.getOrCreate(alice.address as HexAddress);
    const amount = roundMoney(state.approvedWithdrawals);
    if (amount <= 0)
      throw conflict("DEMO_NO_APPROVED_WITHDRAWAL", "Approve withdrawal first");

    const publicClient = this.publicClient(contracts);
    await this.ensureAliceHasGas(contracts, alice);
    const txHash = await this.aliceWallet(contracts, alice).writeContract({
      address: contracts.collateralVault.address,
      abi: contracts.collateralVault.abi,
      functionName: "withdrawApproved",
      args: [parseUsdc(amount)],
    });
    await this.waitForSuccess(publicClient, txHash);

    return this.actionResult(
      "withdraw",
      `Withdrew ${amount} mUSDC from the Vault.`,
      { txHash },
    );
  }

  private async placeSignedDemoOrder(
    side: "BUY" | "SELL",
    quantity: number,
    clientOrderId: string,
  ): Promise<OrderResult> {
    const contracts = await this.loadContractsOrThrow();
    const alice = this.aliceAccount();
    const nonce = this.signedIntentService.issueNonce(
      alice.address as HexAddress,
    );
    const order = {
      userAddress: getAddress(alice.address) as HexAddress,
      symbol: this.appConfig.defaultSymbol,
      side,
      type: "MARKET" as const,
      quantity,
      clientOrderId,
    };
    const intent = buildTradingOrderIntent({
      order,
      nonce: nonce.nonce,
      deadline: Math.floor(Date.now() / 1000) + 300,
    });
    const signature = await alice.signTypedData!(
      buildSignedIntentTypedData({
        chainId: this.appConfig.chainId,
        verifyingContract: contracts.collateralVault.address,
        intent,
      }),
    );
    const verified = await this.signedIntentService.verifySignedTradingOrder(
      order,
      intent,
      signature,
    );
    return this.tradingEngine.placeOrder(verified);
  }

  private async withdrawableAmount(): Promise<number> {
    const contracts = await this.loadContractsOrThrow();
    const publicClient = this.publicClient(contracts);
    const balance = (await publicClient.readContract({
      address: contracts.collateralVault.address,
      abi: contracts.collateralVault.abi,
      functionName: "balanceOf",
      args: [this.aliceAccount().address],
    })) as bigint;
    const amount = fromUsdc(balance);
    if (amount <= 0)
      throw conflict(
        "DEMO_NO_VAULT_BALANCE",
        "No on-chain Vault balance to withdraw",
      );
    return amount;
  }

  private async actionResult(
    action: string,
    message: string,
    extras: Partial<DemoActionResult> = {},
  ): Promise<DemoActionResult> {
    return {
      action,
      message,
      ...extras,
      state: await this.getState(),
    };
  }

  private snapshot(userAddress: HexAddress): Portfolio {
    return this.ledger.snapshot(
      userAddress,
      (symbol) => this.marketData.getQuote(symbol).price,
      this.appConfig.maxLeverage,
    );
  }

  private async tryLoadContracts(): Promise<LoadedContracts | null> {
    try {
      return await this.loadContractsOrThrow();
    } catch {
      return null;
    }
  }

  private async loadContractsOrThrow(): Promise<LoadedContracts> {
    const contracts = await loadContractsConfig(this.appConfig.contractsFile);
    if (!hasUsableVaultDeployment(contracts) || !contracts.mockUSDC.address) {
      throw conflict(
        "DEMO_CONTRACTS_NOT_READY",
        `${this.appConfig.contractsFile} does not contain deployed MockUSDC/CollateralVault addresses. Run npm run chain and npm run deploy:local first.`,
      );
    }

    return {
      ...contracts,
      mockUSDC: {
        address: getAddress(contracts.mockUSDC.address),
        abi: contracts.mockUSDC.abi as Abi,
      },
      collateralVault: {
        address: getAddress(contracts.collateralVault.address as Address),
        abi: contracts.collateralVault.abi as Abi,
      },
    };
  }

  private publicClient(contracts: ContractsConfig) {
    const chain = this.chain(contracts);
    return createPublicClient({
      chain,
      transport: http(this.appConfig.rpcUrl),
    });
  }

  private operatorWallet(
    contracts: ContractsConfig,
    account = this.operatorAccount(),
  ) {
    const chain = this.chain(contracts);
    return createWalletClient({
      account,
      chain,
      transport: http(this.appConfig.rpcUrl),
    });
  }

  private aliceWallet(
    contracts: ContractsConfig,
    account = this.aliceAccount(),
  ) {
    const chain = this.chain(contracts);
    return createWalletClient({
      account,
      chain,
      transport: http(this.appConfig.rpcUrl),
    });
  }

  private chain(contracts: ContractsConfig) {
    return defineChain({
      id: this.appConfig.chainId,
      name: contracts.network ?? "Local Hardhat",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [this.appConfig.rpcUrl] } },
    });
  }

  private operatorAccount(): Account {
    return privateKeyToAccount(
      normalizePrivateKey(
        this.appConfig.operatorPrivateKey ?? LOCAL_HARDHAT_OPERATOR_PRIVATE_KEY,
      ),
    );
  }

  private aliceAccount(): Account {
    if (this.appConfig.alicePrivateKey) {
      return privateKeyToAccount(
        normalizePrivateKey(this.appConfig.alicePrivateKey),
      );
    }

    return mnemonicToAccount(LOCAL_HARDHAT_MNEMONIC, { accountIndex: 1 });
  }

  private async ensureAliceHasGas(
    contracts: ContractsConfig,
    alice = this.aliceAccount(),
  ): Promise<void> {
    const publicClient = this.publicClient(contracts);
    const balance = await publicClient.getBalance({ address: alice.address });

    if (balance >= parseEther("0.05")) return;

    const txHash = await this.operatorWallet(contracts).sendTransaction({
      to: alice.address,
      value: parseEther("1"),
    });
    await this.waitForSuccess(publicClient, txHash);
  }

  private async waitForSuccess(
    publicClient: ReturnType<typeof createPublicClient>,
    txHash: Hex,
  ) {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });
    if (receipt.status !== "success")
      throw conflict(
        "DEMO_TX_REVERTED",
        `Demo transaction reverted: ${txHash}`,
      );
  }
}

function normalizePrivateKey(value: string): Hex {
  const trimmed = value.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as Hex;
}

function parseUsdc(amount: number): bigint {
  return parseUnits(String(amount), 6);
}

function fromUsdc(amount: bigint): number {
  return Number(formatUnits(amount, 6));
}
