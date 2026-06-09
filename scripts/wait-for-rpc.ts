const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const timeoutMs = Number(process.env.WAIT_TIMEOUT_MS ?? 60_000);
const intervalMs = Number(process.env.WAIT_INTERVAL_MS ?? 1_000);
const startedAt = Date.now();

async function main(): Promise<void> {
  while (Date.now() - startedAt < timeoutMs) {
    if (await isRpcReady()) {
      console.log(`RPC is ready: ${rpcUrl}`);
      return;
    }
    await sleep(intervalMs);
  }

  throw new Error(`RPC did not become ready within ${timeoutMs}ms: ${rpcUrl}`);
}

async function isRpcReady(): Promise<boolean> {
  try {
    const response = await fetch(rpcUrl, {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
