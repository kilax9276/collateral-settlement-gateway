import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const chainId = process.env.CHAIN_ID ?? "31337";
const backendHost = process.env.HOST ?? "127.0.0.1";
const backendPort = Number(process.env.PORT ?? 3000);
const frontendHost = process.env.FRONTEND_HOST ?? "127.0.0.1";
const frontendPort = Number(process.env.FRONTEND_PORT ?? 5173);
const contractsFile = resolve(
  projectRoot,
  process.env.CONTRACTS_FILE ?? "backend/src/generated/contracts.json",
);
const sqlitePath = resolve(
  projectRoot,
  process.env.SQLITE_PATH ?? "backend/data/app.db",
);
const defaultOperatorPrivateKey =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const operatorPrivateKey =
  process.env.OPERATOR_PRIVATE_KEY ?? defaultOperatorPrivateKey;
const backendUrl = `http://${backendHost}:${backendPort}`;
const adminToken = process.env.GATEWAY_ADMIN_TOKEN ?? "change-me-admin-token";
const frontendUrl = `http://${frontendHost}:${frontendPort}/dashboard`;
const childProcesses: ChildProcess[] = [];

async function main(): Promise<void> {
  await resetSqlite();

  const rpcAlreadyRunning = await isRpcReady(rpcUrl);
  if (rpcAlreadyRunning) {
    console.log(`Using existing local chain at ${rpcUrl}`);
  } else {
    console.log("Starting local Hardhat chain...");
    childProcesses.push(
      spawnProcess("npm", ["run", "local:chain"], {
        RPC_URL: rpcUrl,
        CHAIN_ID: chainId,
      }),
    );
    await waitUntil(() => isRpcReady(rpcUrl), `Hardhat RPC at ${rpcUrl}`);
  }

  console.log("Deploying contracts...");
  await runCommand("npm", ["run", "local:deploy"], {
    RPC_URL: rpcUrl,
    CHAIN_ID: chainId,
    CONTRACTS_FILE: contractsFile,
    OPERATOR_PRIVATE_KEY: operatorPrivateKey,
  });

  console.log("Starting backend...");
  childProcesses.push(
    spawnProcess("npm", ["run", "local:backend"], {
      PORT: String(backendPort),
      HOST: backendHost,
      RPC_URL: rpcUrl,
      CHAIN_ID: chainId,
      CONTRACTS_FILE: contractsFile,
      OPERATOR_PRIVATE_KEY: operatorPrivateKey,
      STORAGE_DRIVER: "sqlite",
      SQLITE_PATH: sqlitePath,
      MARKET_DATA_PROVIDER: "mock",
      INDEXER_ENABLED: "true",
      ENABLE_DEMO_ROUTES: "true",
      GATEWAY_ADMIN_TOKEN: adminToken,
    }),
  );
  await waitUntil(
    () => isHttpOk(`${backendUrl}/health`),
    `backend at ${backendUrl}`,
  );

  console.log("Starting dashboard frontend...");
  childProcesses.push(
    spawnProcess("npm", ["run", "local:frontend"], {
      FRONTEND_HOST: frontendHost,
      FRONTEND_PORT: String(frontendPort),
      BACKEND_URL: backendUrl,
    }),
  );
  await waitUntil(
    () => isHttpOk(`${frontendUrl}`),
    `dashboard at ${frontendUrl}`,
  );

  console.log(
    "Preparing demo Alice wallet and protocol insurance liquidity...",
  );
  await postJson(`${backendUrl}/demo/mint`, {});

  console.log("\nLocal Collateral Settlement Gateway demo is ready.");
  console.log(`Backend API:     ${backendUrl}`);
  console.log(`Swagger UI:      ${backendUrl}/docs`);
  console.log(`Dashboard UI:    ${frontendUrl}`);
  console.log("Alice has demo mUSDC and the Vault insurance fund is funded.");
  console.log(
    "Use the dashboard buttons to Approve Vault, Deposit, Open Long, Move Price Up, Close Position, Settle P&L, and Withdraw.",
  );
  console.log("\nPress Ctrl+C to stop the local demo processes.");

  await waitForever();
}

async function resetSqlite(): Promise<void> {
  if ((process.env.DEMO_RESET_DB ?? "true").toLowerCase() === "false") return;
  await Promise.all([
    rm(sqlitePath, { force: true }),
    rm(`${sqlitePath}-shm`, { force: true }),
    rm(`${sqlitePath}-wal`, { force: true }),
  ]);
}

function spawnProcess(
  command: string,
  args: string[],
  env: Record<string, string>,
): ChildProcess {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGINT") {
      console.error(
        `${command} ${args.join(" ")} exited with code ${code ?? signal}`,
      );
      shutdown(1);
    }
  });

  return child;
}

function runCommand(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(`${command} ${args.join(" ")} exited with code ${code}`),
        );
    });
    child.on("error", reject);
  });
}

async function isRpcReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_chainId",
        params: [],
        id: 1,
      }),
    });
    if (!response.ok) return false;
    const json = (await response.json()) as { result?: string };
    return typeof json.result === "string";
  } catch {
    return false;
  }
}

async function isHttpOk(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function postJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`POST ${url} failed with HTTP ${response.status}: ${text}`);
  }
}

async function waitUntil(
  check: () => Promise<boolean>,
  label: string,
): Promise<void> {
  const timeoutMs = Number(process.env.DEMO_WAIT_TIMEOUT_MS ?? 60_000);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      console.log(`${label} is ready.`);
      return;
    }
    await sleep(1_000);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of childProcesses) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function waitForever(): Promise<void> {
  return new Promise(() => undefined);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  shutdown(1);
});
