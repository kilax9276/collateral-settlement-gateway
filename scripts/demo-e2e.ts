import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseEther,
  parseUnits,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { buildApp } from "../backend/src/app.js";
import { config as baseConfig } from "../backend/src/config.js";
import {
  buildSignedIntentTypedData,
  buildTradingOrderIntent,
  buildWithdrawalRequestIntent,
} from "../backend/src/core/auth/signedIntentService.js";
import type { ContractsConfig } from "../backend/src/types/contracts.js";
import type { SignedOrderPayload } from "../backend/src/types/domain.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const contractsFile = resolve(
  projectRoot,
  process.env.CONTRACTS_FILE ?? "backend/src/generated/contracts.json",
);
const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const chainId = Number(process.env.CHAIN_ID ?? 31337);
const backendPort = Number(
  process.env.DEMO_BACKEND_PORT ?? process.env.PORT ?? 3000,
);
const backendHost = process.env.DEMO_BACKEND_HOST ?? "127.0.0.1";
const backendUrl = `http://${backendHost}:${backendPort}`;
const adminToken = process.env.GATEWAY_ADMIN_TOKEN ?? "change-me-admin-token";
const adminHeaders = { authorization: `Bearer ${adminToken}` };
const demoSqlitePath = resolve(
  projectRoot,
  process.env.SQLITE_PATH ?? "backend/data/demo-e2e.db",
);

const DEPLOYER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const HARDHAT_MNEMONIC =
  "test test test test test test test test test test test junk";

const alice = mnemonicToAccount(HARDHAT_MNEMONIC, { accountIndex: 1 });
const deployer = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);

const chain = defineChain({
  id: chainId,
  name: "Local Hardhat",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const deployerWallet = createWalletClient({
  account: deployer,
  chain,
  transport: http(rpcUrl),
});
const aliceWallet = createWalletClient({
  account: alice,
  chain,
  transport: http(rpcUrl),
});

type JsonObject = Record<string, unknown>;

type PortfolioResponse = {
  collateral: number;
  equity: number;
  marginUsed: number;
  freeCollateral: number;
  pendingSettlementPnl: number;
  pendingWithdrawals: number;
  approvedWithdrawals: number;
  positions: Array<{
    quantity: number;
    avgEntryPrice: number;
    realizedPnl: number;
    unrealizedPnl: number;
  }>;
  trades: Array<{
    tradeId: string;
    side: string;
    quantity: number;
    price: number;
    fee: number;
    realizedPnlDelta: number;
    latencyMs: number;
  }>;
  settlements: Array<{
    settlementId: string;
    reasonHash: string;
    txHash: string;
    appId: string;
    settlementType: string;
    amountDelta: number;
    pnl: number;
    referenceIds: string[];
    status: string;
  }>;
};

type Contracts = ContractsConfig & {
  mockUSDC: { address: Address; abi: Abi };
  collateralVault: { address: Address; abi: Abi };
};

async function main() {
  await rm(demoSqlitePath, { force: true });
  const startedNode = await ensureHardhatNode();

  try {
    logStep("1", "Deploy MockUSDC and CollateralVault");
    await runCommand("npm", ["run", "deploy:local"], {
      CONTRACTS_FILE: contractsFile,
      RPC_URL: rpcUrl,
      CHAIN_ID: String(chainId),
      OPERATOR_PRIVATE_KEY: DEPLOYER_PRIVATE_KEY,
    });

    const contracts = await loadContracts();
    await assertChainIsReady();

    logStep("2", "Start backend with blockchain indexer");
    const { app } = await buildApp(
      {
        ...baseConfig,
        port: backendPort,
        host: backendHost,
        rpcUrl,
        chainId,
        contractsFile,
        operatorPrivateKey: DEPLOYER_PRIVATE_KEY,
        gatewayAdminToken: adminToken,
        gatewayAdminTokenConfigured: Boolean(
          process.env.GATEWAY_ADMIN_TOKEN?.trim(),
        ),
        indexerEnabled: true,
        indexerPollIntervalMs: 250,
        marketDataProvider: "mock",
        defaultBtcPrice: 65_000,
        storageDriver: "sqlite",
        sqlitePath: demoSqlitePath,
      },
      { logger: false, startIndexer: true },
    );
    await app.listen({ port: backendPort, host: backendHost });

    try {
      logStep("3", "Mint 10,000 mUSDC to Alice and fund protocol insurance");
      const aliceInitialBalance = await tokenBalance(contracts, alice.address);
      console.log(`Alice address: ${alice.address}`);
      console.log(`Operator address: ${deployer.address}`);
      console.log(
        `Alice token balance before mint: ${aliceInitialBalance} mUSDC`,
      );

      await writeAndWait(
        deployerWallet.sendTransaction({
          to: alice.address,
          value: parseEther("1"),
        }),
      );

      await writeAndWait(
        deployerWallet.writeContract({
          address: contracts.mockUSDC.address,
          abi: contracts.mockUSDC.abi,
          functionName: "mint",
          args: [alice.address, parseUsdc("10000")],
        }),
      );

      // Positive P&L is paid from protocol-owned insurance liquidity, not from
      // Alice's collateral. The funder mints demo mUSDC, approves the Vault,
      // and calls fundInsurance so the accounting is explicit on-chain.
      await writeAndWait(
        deployerWallet.writeContract({
          address: contracts.mockUSDC.address,
          abi: contracts.mockUSDC.abi,
          functionName: "mint",
          args: [deployer.address, parseUsdc("500")],
        }),
      );
      await writeAndWait(
        deployerWallet.writeContract({
          address: contracts.mockUSDC.address,
          abi: contracts.mockUSDC.abi,
          functionName: "approve",
          args: [contracts.collateralVault.address, parseUsdc("500")],
        }),
      );
      await writeAndWait(
        deployerWallet.writeContract({
          address: contracts.collateralVault.address,
          abi: contracts.collateralVault.abi,
          functionName: "fundInsurance",
          args: [parseUsdc("500")],
        }),
      );

      console.log(
        `Alice token balance after mint: ${await tokenBalance(contracts, alice.address)} mUSDC`,
      );
      console.log(
        `Insurance balance after funding: ${await insuranceBalance(contracts)} mUSDC`,
      );

      logStep("4", "Alice approves Vault and deposits 10,000 mUSDC on-chain");
      await writeAndWait(
        aliceWallet.writeContract({
          address: contracts.mockUSDC.address,
          abi: contracts.mockUSDC.abi,
          functionName: "approve",
          args: [contracts.collateralVault.address, parseUsdc("10000")],
        }),
      );
      const depositTxHash = await writeAndWait(
        aliceWallet.writeContract({
          address: contracts.collateralVault.address,
          abi: contracts.collateralVault.abi,
          functionName: "deposit",
          args: [parseUsdc("10000")],
        }),
      );
      console.log(`Deposit tx hash: ${depositTxHash}`);
      console.log(
        `Alice on-chain Vault balance: ${await vaultBalance(contracts, alice.address)} mUSDC`,
      );

      logStep("5", "Wait until backend indexer sees Deposited event");
      const indexedDeposit = await waitForPortfolio(
        (portfolio) => portfolio.collateral >= 10_000,
      );
      printPortfolio("Backend portfolio after indexed deposit", indexedDeposit);

      logStep("6", "Alice opens BTC-USD long off-chain");
      const openResult = await postSignedOrder(contracts, {
        side: "BUY",
        quantity: 0.05,
        clientOrderId: `demo-buy-${Date.now()}`,
      });
      console.log(`Open order response: ${prettyCompact(openResult)}`);
      printPortfolio("Portfolio after opening long", await getPortfolio());

      logStep("7", "Move BTC price upward to create unrealized profit");
      await apiPost("/examples/trading/market/BTC-USD/price", {
        price: 67_000,
      });
      printPortfolio("Portfolio after price move", await getPortfolio());

      logStep("8", "Alice closes BTC-USD long with profit");
      const closeResult = await postSignedOrder(contracts, {
        side: "SELL",
        quantity: 0.05,
        clientOrderId: `demo-sell-${Date.now()}`,
      });
      console.log(`Close order response: ${prettyCompact(closeResult)}`);
      const afterClose = await getPortfolio();
      printPortfolio("Portfolio after close / before settlement", afterClose);

      logStep("9", "Backend submits generic TRADING_PNL settlement to Vault");
      const settlementRequest = {
        userAddress: alice.address,
        appId: "trading-example",
        settlementType: "TRADING_PNL",
        amountDelta: String(afterClose.pendingSettlementPnl),
        reasonHash: hashReason({
          appId: "trading-example",
          settlementType: "TRADING_PNL",
          userAddress: alice.address,
          amountDelta: afterClose.pendingSettlementPnl,
          tradeIds: afterClose.trades.map((trade) => trade.tradeId ?? "trade"),
        }),
        referenceIds: afterClose.trades.map(
          (trade, index) => trade.tradeId ?? `trade-${index}`,
        ),
        metadata: {
          source: "demo-e2e",
          realizedPnl: afterClose.pendingSettlementPnl,
        },
      };
      const settlement = await apiPost<{
        settlement: {
          settlementId: string;
          reasonHash: string;
          txHash: string;
          appId: string;
          settlementType: string;
          amountDelta: number;
          pnl: number;
          referenceIds: string[];
          status: string;
        };
        portfolio: PortfolioResponse;
      }>("/settlements", settlementRequest);
      console.log(`Settlement id: ${settlement.settlement.settlementId}`);
      console.log(
        `Settlement type: ${settlement.settlement.appId}/${settlement.settlement.settlementType}`,
      );
      console.log(
        `Settlement reason hash: ${settlement.settlement.reasonHash}`,
      );
      console.log(`Settlement tx hash: ${settlement.settlement.txHash}`);
      console.log(
        `Settlement amountDelta: ${settlement.settlement.amountDelta} mUSDC`,
      );
      console.log(`Settlement status: ${settlement.settlement.status}`);
      printPortfolio(
        "Portfolio after settlement confirmation",
        settlement.portfolio,
      );
      console.log(
        `Alice on-chain Vault balance after settlement: ${await vaultBalance(contracts, alice.address)} mUSDC`,
      );
      console.log(
        `Insurance balance after settlement: ${await insuranceBalance(contracts)} mUSDC`,
      );

      logStep(
        "10",
        "Alice requests, receives backend approval, and withdraws updated Vault balance",
      );
      const aliceVaultBalanceMicro = await readVaultBalanceMicro(
        contracts,
        alice.address,
      );
      const aliceVaultBalance = Number(formatUnits(aliceVaultBalanceMicro, 6));

      const withdrawalIntentId = await createVerifiedWithdrawalIntent(
        contracts,
        aliceVaultBalance,
      );
      const request = await apiPost<{
        withdrawal: { txHash: string; amount: number; status: string };
      }>("/withdrawals/request", {
        userAddress: alice.address,
        amount: aliceVaultBalance,
        signedIntentId: withdrawalIntentId,
      });
      console.log(`Withdraw request tx hash: ${request.withdrawal.txHash}`);
      console.log(`Withdraw request status: ${request.withdrawal.status}`);

      const approval = await apiPost<{
        withdrawal: { txHash: string; amount: number; status: string };
      }>(`/withdrawals/approve/${alice.address}`, {
        amount: aliceVaultBalance,
      });
      console.log(`Withdraw approval tx hash: ${approval.withdrawal.txHash}`);
      console.log(`Withdraw approval status: ${approval.withdrawal.status}`);

      const withdrawTxHash = await writeAndWait(
        aliceWallet.writeContract({
          address: contracts.collateralVault.address,
          abi: contracts.collateralVault.abi,
          functionName: "withdrawApproved",
          args: [aliceVaultBalanceMicro],
        }),
      );
      console.log(`WithdrawApproved tx hash: ${withdrawTxHash}`);

      const afterWithdraw = await waitForPortfolio(
        (portfolio) => portfolio.collateral === 0,
      );
      console.log(
        `Alice final token balance: ${await tokenBalance(contracts, alice.address)} mUSDC`,
      );
      console.log(
        `Alice final on-chain Vault accounting balance: ${await vaultBalance(contracts, alice.address)} mUSDC`,
      );
      console.log(
        `Insurance balance after withdraw: ${await insuranceBalance(contracts)} mUSDC`,
      );
      console.log(
        `Vault token balance after withdraw: ${await tokenBalance(contracts, contracts.collateralVault.address)} mUSDC`,
      );
      printPortfolio("Backend portfolio after indexed withdraw", afterWithdraw);

      logStep("Done", "End-to-end demo completed successfully");
    } finally {
      await app.close();
    }
  } finally {
    if (startedNode) {
      await stopHardhatNode(startedNode);
    }
  }
}

async function stopHardhatNode(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolvePromise) => {
    child.once("close", () => resolvePromise());
    child.kill("SIGTERM");
    setTimeout(() => resolvePromise(), 2_000).unref();
  });
}

async function ensureHardhatNode(): Promise<ChildProcess | null> {
  if (await isRpcReady()) {
    console.log(`Using existing Hardhat RPC at ${rpcUrl}`);
    return null;
  }

  logStep("0", "Start local Hardhat node");
  const child = spawn(
    hardhatBin(),
    ["node", "--hostname", rpcHostname(), "--port", String(rpcPort())],
    {
      cwd: projectRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout.on("data", (data: Buffer) => {
    const text = data.toString();
    if (text.includes("Started HTTP and WebSocket JSON-RPC server")) {
      console.log("Hardhat node started.");
    }
  });
  child.stderr.on("data", (data: Buffer) => process.stderr.write(data));

  await waitUntil(
    isRpcReady,
    30_000,
    "Timed out while waiting for Hardhat RPC",
  );
  return child;
}

function hardhatBin(): string {
  return resolve(projectRoot, "node_modules/.bin/hardhat");
}

function rpcHostname(): string {
  return new URL(rpcUrl).hostname;
}

function rpcPort(): number {
  const parsed = Number(new URL(rpcUrl).port || 8545);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`Invalid RPC_URL: ${rpcUrl}`);
  return parsed;
}

async function isRpcReady(): Promise<boolean> {
  try {
    await publicClient.getBlockNumber();
    return true;
  } catch {
    return false;
  }
}

async function assertChainIsReady(): Promise<void> {
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== chainId) {
    throw new Error(
      `Connected to chainId=${actualChainId}, expected ${chainId}`,
    );
  }
}

async function runCommand(
  command: string,
  args: string[],
  extraEnv: Record<string, string>,
) {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (data: Buffer) => process.stdout.write(data));
    child.stderr.on("data", (data: Buffer) => process.stderr.write(data));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(`${command} ${args.join(" ")} exited with code ${code}`),
        );
    });
  });
}

async function loadContracts(): Promise<Contracts> {
  const raw = await readFile(contractsFile, "utf8");
  const contracts = JSON.parse(raw) as ContractsConfig;
  if (!contracts.mockUSDC.address || !contracts.collateralVault.address) {
    throw new Error(
      "contracts.json does not contain deployed contract addresses",
    );
  }

  return {
    ...contracts,
    mockUSDC: {
      address: getAddress(contracts.mockUSDC.address),
      abi: contracts.mockUSDC.abi as Abi,
    },
    collateralVault: {
      address: getAddress(contracts.collateralVault.address),
      abi: contracts.collateralVault.abi as Abi,
    },
  };
}

async function writeAndWait(txPromise: Promise<Hex>): Promise<Hex> {
  const hash = await txPromise;
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`Transaction reverted: ${hash}`);
  }
  return hash;
}

async function tokenBalance(
  contracts: Contracts,
  address: Address,
): Promise<string> {
  const balance = (await publicClient.readContract({
    address: contracts.mockUSDC.address,
    abi: contracts.mockUSDC.abi,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
  return formatUsdc(balance);
}

async function vaultBalance(
  contracts: Contracts,
  address: Address,
): Promise<string> {
  const balance = await readVaultBalanceMicro(contracts, address);
  return formatUsdc(balance);
}

async function insuranceBalance(contracts: Contracts): Promise<string> {
  const balance = (await publicClient.readContract({
    address: contracts.collateralVault.address,
    abi: contracts.collateralVault.abi,
    functionName: "insuranceBalance",
  })) as bigint;
  return formatUsdc(balance);
}

async function readVaultBalanceMicro(
  contracts: Contracts,
  address: Address,
): Promise<bigint> {
  return (await publicClient.readContract({
    address: contracts.collateralVault.address,
    abi: contracts.collateralVault.abi,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
}

function parseUsdc(amount: string): bigint {
  return parseUnits(amount, 6);
}

function formatUsdc(amount: bigint): string {
  return stripTrailingZeros(formatUnits(amount, 6));
}

function stripTrailingZeros(value: string): string {
  return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

async function getPortfolio(): Promise<PortfolioResponse> {
  return apiGet<PortfolioResponse>(`/portfolio/${alice.address}`);
}

async function waitForPortfolio(
  predicate: (portfolio: PortfolioResponse) => boolean,
): Promise<PortfolioResponse> {
  let latest: PortfolioResponse | null = null;
  await waitUntil(
    async () => {
      latest = await getPortfolio();
      return predicate(latest);
    },
    20_000,
    "Timed out while waiting for backend portfolio state",
  );

  if (!latest) throw new Error("Backend portfolio was not loaded");
  return latest;
}

async function createVerifiedWithdrawalIntent(
  contracts: Contracts,
  amount: number,
): Promise<string> {
  const nonce = await apiGet<{ nonce: string }>(`/auth/nonce/${alice.address}`);
  const intent = buildWithdrawalRequestIntent({
    userAddress: alice.address,
    amount,
    chainId,
    vaultAddress: contracts.collateralVault.address,
    nonce: nonce.nonce,
    deadline: Math.floor(Date.now() / 1000) + 300,
  });
  const signature = await alice.signTypedData(
    buildSignedIntentTypedData({
      chainId,
      verifyingContract: contracts.collateralVault.address,
      intent,
    }),
  );
  const verified = await apiPost<{ intentId: string }>("/intents/verify", {
    intent,
    signature,
  });
  return verified.intentId;
}

async function postSignedOrder(
  contracts: Contracts,
  overrides: Partial<SignedOrderPayload>,
): Promise<JsonObject> {
  const nonce = await apiGet<{ nonce: string }>(`/auth/nonce/${alice.address}`);
  const order = {
    userAddress: overrides.userAddress ?? alice.address,
    symbol: overrides.symbol ?? "BTC-USD",
    side: overrides.side ?? "BUY",
    type: "MARKET" as const,
    quantity: overrides.quantity ?? 0.01,
    clientOrderId: overrides.clientOrderId ?? `demo-${Date.now()}`,
  };
  const intent = buildTradingOrderIntent({
    order,
    nonce: overrides.nonce ?? nonce.nonce,
    deadline: overrides.deadline ?? Math.floor(Date.now() / 1000) + 300,
  });
  const signature = await alice.signTypedData(
    buildSignedIntentTypedData({
      chainId,
      verifyingContract: contracts.collateralVault.address,
      intent,
    }),
  );

  return apiPost<JsonObject>("/examples/trading/orders", {
    order,
    intent,
    signature,
  });
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${backendUrl}${path}`);
  return parseApiResponse<T>(response);
}

async function apiPost<T = JsonObject>(
  path: string,
  body: JsonObject,
): Promise<T> {
  const response = await fetch(`${backendUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...adminHeaders },
    body: JSON.stringify(body),
  });
  return parseApiResponse<T>(response);
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new Error(
      `${response.status} ${body.error ?? "API_ERROR"}: ${body.message ?? JSON.stringify(body)}`,
    );
  }
  return body as T;
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await delay(250);
  }
  throw new Error(timeoutMessage);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function logStep(step: string, title: string): void {
  console.log(`\n=== ${step}. ${title} ===`);
}

function printPortfolio(title: string, portfolio: PortfolioResponse): void {
  const position = portfolio.positions[0];
  const lastTrade = portfolio.trades.at(-1);
  console.log(`${title}:`);
  console.log(`  collateral: ${portfolio.collateral}`);
  console.log(`  equity: ${portfolio.equity}`);
  console.log(`  marginUsed: ${portfolio.marginUsed}`);
  console.log(`  freeCollateral: ${portfolio.freeCollateral}`);
  console.log(`  pendingSettlementPnl: ${portfolio.pendingSettlementPnl}`);
  console.log(`  pendingWithdrawals: ${portfolio.pendingWithdrawals}`);
  console.log(`  approvedWithdrawals: ${portfolio.approvedWithdrawals}`);
  if (position) {
    console.log(
      `  position: qty=${position.quantity}, avg=${position.avgEntryPrice}, realized=${position.realizedPnl}, unrealized=${position.unrealizedPnl}`,
    );
  } else {
    console.log("  position: none");
  }
  if (lastTrade) {
    console.log(
      `  lastTrade: ${lastTrade.side} ${lastTrade.quantity} @ ${lastTrade.price}, fee=${lastTrade.fee}, realizedDelta=${lastTrade.realizedPnlDelta}, latencyMs=${lastTrade.latencyMs}`,
    );
  }
  if (portfolio.settlements.length > 0) {
    const lastSettlement = portfolio.settlements.at(-1)!;
    console.log(
      `  lastSettlement: ${lastSettlement.appId}/${lastSettlement.settlementType} amountDelta=${lastSettlement.amountDelta}, status=${lastSettlement.status}, txHash=${lastSettlement.txHash}`,
    );
  }
}

function prettyCompact(value: JsonObject): string {
  return JSON.stringify(value, (_key, nestedValue) => {
    if (Array.isArray(nestedValue) && nestedValue.length > 2)
      return `[${nestedValue.length} items]`;
    return nestedValue;
  });
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

function hashReason(value: unknown): `0x${string}` {
  return keccak256(toHex(stableStringify(value)));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
