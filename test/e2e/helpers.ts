import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../backend/src/app.js";
import { config as baseConfig } from "../../backend/src/config.js";
import type { ContractsConfig } from "../../backend/src/types/contracts.js";
import type { HexAddress, Portfolio } from "../../backend/src/types/domain.js";

export const projectRoot = resolve(process.cwd());
export const rpcUrl = process.env.E2E_RPC_URL ?? "http://127.0.0.1:18545";
export const chainId = Number(process.env.CHAIN_ID ?? 31337);
export const deployerPrivateKey =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const hardhatMnemonic =
  "test test test test test test test test test test test junk";
export const adminToken = "test-admin-token";
export const adminHeaders = { authorization: `Bearer ${adminToken}` };
export const tradingAppHeaders = {
  "x-app-id": "trading-example",
  "x-app-secret": "test-trading-secret",
};
export const registeredApps =
  "trading-example:test-trading-secret,fantasy-trading-app:test-external-secret";

export const deployer = privateKeyToAccount(deployerPrivateKey);
export const alice = mnemonicToAccount(hardhatMnemonic, { accountIndex: 1 });

export const localChain = defineChain({
  id: chainId,
  name: "Local Hardhat",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

function rpcTransport(timeout = 5_000) {
  return http(rpcUrl, { retryCount: 0, timeout });
}

function freshPublicClient() {
  return createPublicClient({
    chain: localChain,
    transport: rpcTransport(),
  });
}

export const publicClient = freshPublicClient();
export const deployerWallet = createWalletClient({
  account: deployer,
  chain: localChain,
  transport: rpcTransport(),
});
export const aliceWallet = createWalletClient({
  account: alice,
  chain: localChain,
  transport: rpcTransport(),
});

let sharedNode: ChildProcess | null = null;

export type DeployedContracts = ContractsConfig & {
  mockUSDC: { address: Address; abi: Abi };
  collateralVault: { address: Address; abi: Abi };
};

export type E2EHarness = {
  node: ChildProcess | null;
  tempDir: string;
  contractsFile: string;
  contracts: DeployedContracts;
  app: FastifyInstance;
  services: Awaited<ReturnType<typeof buildApp>>["services"];
  cleanup: () => Promise<void>;
};

export async function startHardhatNode(): Promise<ChildProcess | null> {
  if (await isRpcReady()) return sharedNode;

  sharedNode = spawn(
    hardhatBin(),
    ["node", "--hostname", rpcHostname(), "--port", String(rpcPort())],
    {
      cwd: projectRoot,
      env: { ...process.env },
      stdio: ["pipe", "ignore", "ignore"],
    },
  );

  await waitUntil(
    isRpcReady,
    30_000,
    "Timed out while waiting for local Hardhat RPC",
  );
  return sharedNode;
}

export async function stopHardhatNode(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolvePromise) => {
    child.once("close", () => resolvePromise());
    child.kill("SIGTERM");
    setTimeout(() => resolvePromise(), 2_000).unref();
  });
}

export async function stopSharedHardhatNode(): Promise<void> {
  if (!sharedNode) return;
  await stopHardhatNode(sharedNode);
  sharedNode = null;
}

export async function createE2EHarness(
  options: { startIndexer?: boolean } = {},
): Promise<E2EHarness> {
  const node = await startHardhatNode();
  const tempDir = await mkdtemp(
    join(tmpdir(), "collateral-settlement-gateway-e2e-"),
  );
  const contractsFile = join(tempDir, "contracts.json");

  await runCommand(
    hardhatBin(),
    ["run", "scripts/deploy.ts", "--network", "localhost"],
    {
      CONTRACTS_FILE: contractsFile,
      RPC_URL: rpcUrl,
      CHAIN_ID: String(chainId),
      OPERATOR_PRIVATE_KEY: deployerPrivateKey,
    },
  );

  const contracts = await loadContracts(contractsFile);
  const built = await buildApp(
    {
      ...baseConfig,
      host: "127.0.0.1",
      port: 0,
      rpcUrl,
      chainId,
      contractsFile,
      operatorPrivateKey: deployerPrivateKey,
      gatewayAdminToken: adminToken,
      gatewayAdminTokenConfigured: true,
      registeredApps,
      indexerEnabled: true,
      indexerPollIntervalMs: 100,
      marketDataProvider: "mock",
      defaultBtcPrice: 65_000,
      takerFeeBps: 5,
      maxLeverage: 5,
      storageDriver: "sqlite",
      sqlitePath: join(tempDir, "app.db"),
    },
    { logger: false, startIndexer: options.startIndexer ?? true },
  );

  return {
    node,
    tempDir,
    contractsFile,
    contracts,
    app: built.app,
    services: built.services,
    cleanup: async () => {
      await built.services.blockchainIndexer.stop().catch(() => undefined);
      await built.services.marketData.stop().catch(() => undefined);
      await withTimeout(
        built.app.close(),
        5_000,
        "Timed out while closing Fastify app",
      ).catch(() => undefined);
      await rm(tempDir, { recursive: true, force: true });
      // The shared local Hardhat RPC is intentionally kept alive for the whole Vitest run.
    },
  };
}

export async function mintAndDeposit(
  contracts: DeployedContracts,
  amount: string,
  insuranceLiquidity = "0",
): Promise<void> {
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
      args: [alice.address, parseUsdc(amount)],
    }),
  );

  if (Number(insuranceLiquidity) > 0) {
    await writeAndWait(
      deployerWallet.writeContract({
        address: contracts.mockUSDC.address,
        abi: contracts.mockUSDC.abi,
        functionName: "mint",
        args: [deployer.address, parseUsdc(insuranceLiquidity)],
      }),
    );

    await writeAndWait(
      deployerWallet.writeContract({
        address: contracts.mockUSDC.address,
        abi: contracts.mockUSDC.abi,
        functionName: "approve",
        args: [
          contracts.collateralVault.address,
          parseUsdc(insuranceLiquidity),
        ],
      }),
    );

    await writeAndWait(
      deployerWallet.writeContract({
        address: contracts.collateralVault.address,
        abi: contracts.collateralVault.abi,
        functionName: "fundInsurance",
        args: [parseUsdc(insuranceLiquidity)],
      }),
    );
  }

  await writeAndWait(
    aliceWallet.writeContract({
      address: contracts.mockUSDC.address,
      abi: contracts.mockUSDC.abi,
      functionName: "approve",
      args: [contracts.collateralVault.address, parseUsdc(amount)],
    }),
  );

  await writeAndWait(
    aliceWallet.writeContract({
      address: contracts.collateralVault.address,
      abi: contracts.collateralVault.abi,
      functionName: "deposit",
      args: [parseUsdc(amount)],
    }),
  );
}

export async function waitForIndexedPortfolio(
  app: FastifyInstance,
  userAddress: HexAddress,
  predicate: (portfolio: Portfolio) => boolean,
  timeoutMs = 20_000,
): Promise<Portfolio> {
  let latest: Portfolio | null = null;
  await waitUntil(
    async () => {
      const response = await app.inject({
        method: "GET",
        url: `/portfolio/${userAddress}`,
      });
      latest = response.json() as Portfolio;
      return response.statusCode === 200 && predicate(latest);
    },
    timeoutMs,
    "Timed out while waiting for indexed portfolio state",
  );
  if (!latest) throw new Error("No portfolio response received");
  return latest;
}

export async function tokenBalance(
  contracts: DeployedContracts,
  address: Address,
): Promise<number> {
  const balance = (await freshPublicClient().readContract({
    address: contracts.mockUSDC.address,
    abi: contracts.mockUSDC.abi,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
  return Number(formatUnits(balance, 6));
}

export async function vaultBalance(
  contracts: DeployedContracts,
  address: Address,
): Promise<number> {
  const balance = (await freshPublicClient().readContract({
    address: contracts.collateralVault.address,
    abi: contracts.collateralVault.abi,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
  return Number(formatUnits(balance, 6));
}

export async function insuranceBalance(
  contracts: DeployedContracts,
): Promise<number> {
  const balance = (await freshPublicClient().readContract({
    address: contracts.collateralVault.address,
    abi: contracts.collateralVault.abi,
    functionName: "insuranceBalance",
  })) as bigint;
  return Number(formatUnits(balance, 6));
}

export async function withdrawAllFromVault(
  contracts: DeployedContracts,
): Promise<Hex> {
  const balance = (await freshPublicClient().readContract({
    address: contracts.collateralVault.address,
    abi: contracts.collateralVault.abi,
    functionName: "balanceOf",
    args: [alice.address],
  })) as bigint;

  await writeAndWait(
    aliceWallet.writeContract({
      address: contracts.collateralVault.address,
      abi: contracts.collateralVault.abi,
      functionName: "requestWithdraw",
      args: [balance],
    }),
  );

  await writeAndWait(
    deployerWallet.writeContract({
      address: contracts.collateralVault.address,
      abi: contracts.collateralVault.abi,
      functionName: "approveWithdraw",
      args: [alice.address, balance],
    }),
  );

  return writeAndWait(
    aliceWallet.writeContract({
      address: contracts.collateralVault.address,
      abi: contracts.collateralVault.abi,
      functionName: "withdrawApproved",
      args: [balance],
    }),
  );
}

export async function loadContracts(
  contractsFile: string,
): Promise<DeployedContracts> {
  const raw = await readFile(contractsFile, "utf8");
  const contracts = JSON.parse(raw) as ContractsConfig;
  if (!contracts.mockUSDC.address || !contracts.collateralVault.address) {
    throw new Error(`Missing deployed addresses in ${contractsFile}`);
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

export async function writeAndWait(txPromise: Promise<Hex>): Promise<Hex> {
  const hash = await withTimeout(
    txPromise,
    30_000,
    "Timed out while submitting transaction",
  );
  const receipt = await withTimeout(
    freshPublicClient().waitForTransactionReceipt({ hash, timeout: 30_000 }),
    35_000,
    `Timed out while waiting for transaction receipt: ${hash}`,
  );
  if (receipt.status !== "success") {
    throw new Error(`Transaction reverted: ${hash}`);
  }
  return hash;
}

export function parseUsdc(amount: string): bigint {
  return parseUnits(amount, 6);
}

function hardhatBin(): string {
  return join(projectRoot, "node_modules/.bin/hardhat");
}

function rpcHostname(): string {
  return new URL(rpcUrl).hostname;
}

function rpcPort(): number {
  const parsed = Number(new URL(rpcUrl).port || 8545);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`Invalid E2E_RPC_URL: ${rpcUrl}`);
  return parsed;
}

export async function isRpcReady(): Promise<boolean> {
  try {
    await freshPublicClient().getChainId();
    return true;
  } catch {
    return false;
  }
}

export async function runCommand(
  command: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  options: { silent?: boolean; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} ${args.join(" ")} timed out`));
    }, options.timeoutMs ?? 120_000);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (!options.silent) process.stdout.write(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (!options.silent) process.stderr.write(data);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with code ${code}\n${stderr}`,
          ),
        );
    });
  });
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(timeoutMessage);
}
