const backendUrl = process.env.BACKEND_URL ?? "http://127.0.0.1:3000";
const timeoutMs = Number(process.env.DEMO_WAIT_TIMEOUT_MS ?? 60_000);
const adminToken = process.env.GATEWAY_ADMIN_TOKEN ?? "change-me-admin-token";

async function main(): Promise<void> {
  await waitUntilBackendReady();
  const response = await fetch(`${backendUrl}/demo/mint`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`,
    },
    body: "{}",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Demo prepare failed. Ensure backend runs with ENABLE_DEMO_ROUTES=true. HTTP ${response.status}: ${text}`,
    );
  }

  const result = (await response.json()) as { message?: string };
  console.log(
    result.message ?? "Demo Alice wallet and insurance liquidity prepared.",
  );
}

async function waitUntilBackendReady(): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${backendUrl}/health`);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Backend did not become ready within ${timeoutMs}ms: ${backendUrl}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
