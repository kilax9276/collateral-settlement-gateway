import { readFile } from "node:fs/promises";
import { network } from "hardhat";
import { getAddress, parseUnits } from "viem";
import type { ContractsConfig } from "../backend/src/types/contracts.js";

const backendUrl = process.env.API_URL ?? "http://127.0.0.1:3000";
const contractsFile =
  process.env.CONTRACTS_FILE ?? "backend/src/generated/contracts.json";
const depositAmount = process.env.DEPOSIT_AMOUNT ?? "10000";

async function waitForIndexedCollateral(
  userAddress: string,
  expectedCollateral: number,
) {
  const deadline = Date.now() + 15_000;
  let lastPortfolio: unknown;

  while (Date.now() < deadline) {
    const response = await fetch(`${backendUrl}/portfolio/${userAddress}`);
    if (!response.ok) {
      throw new Error(
        `Portfolio request failed: ${response.status} ${await response.text()}`,
      );
    }

    const portfolio = (await response.json()) as { collateral: number };
    lastPortfolio = portfolio;
    if (portfolio.collateral >= expectedCollateral) return portfolio;

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Timed out waiting for indexed collateral. Last portfolio: ${JSON.stringify(lastPortfolio)}`,
  );
}

async function main() {
  const contracts = JSON.parse(
    await readFile(contractsFile, "utf8"),
  ) as ContractsConfig;
  if (!contracts.mockUSDC.address || !contracts.collateralVault.address) {
    throw new Error(
      `Run npm run deploy:local first. ${contractsFile} does not contain deployed addresses.`,
    );
  }

  const connection = await network.connect({ network: "localhost" });
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [alice] = await viem.getWalletClients();
  const aliceAddress = getAddress(alice.account.address);
  const amount = parseUnits(depositAmount, 6);

  console.log(`Alice: ${aliceAddress}`);
  console.log(`Minting ${depositAmount} mUSDC to Alice...`);
  let hash = await alice.writeContract({
    address: contracts.mockUSDC.address,
    abi: contracts.mockUSDC.abi,
    functionName: "mint",
    args: [aliceAddress, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  console.log("Approving Vault...");
  hash = await alice.writeContract({
    address: contracts.mockUSDC.address,
    abi: contracts.mockUSDC.abi,
    functionName: "approve",
    args: [contracts.collateralVault.address, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  console.log("Depositing into CollateralVault...");
  hash = await alice.writeContract({
    address: contracts.collateralVault.address,
    abi: contracts.collateralVault.abi,
    functionName: "deposit",
    args: [amount],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Deposit tx: ${hash}`);

  console.log("Waiting for backend indexer to update /portfolio...");
  const portfolio = await waitForIndexedCollateral(
    aliceAddress,
    Number(depositAmount),
  );
  console.log(JSON.stringify(portfolio, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
