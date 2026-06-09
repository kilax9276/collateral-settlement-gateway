import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import type { HexAddress } from "../backend/src/types/domain.js";

type ContractDeployment = {
  address: HexAddress;
};

type DeploymentFile = {
  network: string;
  operator: HexAddress;
  mockUSDC: ContractDeployment;
  collateralVault: ContractDeployment;
};

function normalizeNetworkName(raw: string | undefined): string {
  if (!raw || raw === "sepolia") return "sepolia";
  if (raw === "arbitrum-sepolia" || raw === "arbitrumSepolia")
    return "arbitrumSepolia";
  throw new Error(`Unsupported verification network: ${raw}`);
}

function defaultContractsFile(networkName: string): string {
  return `backend/src/generated/contracts.${networkName}.json`;
}

function runHardhatVerify(networkName: string, args: string[]): void {
  const result = spawnSync(
    "npx",
    ["hardhat", "verify", "--network", networkName, ...args],
    {
      stdio: "inherit",
      env: process.env,
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `hardhat verify failed for ${args[0]} with exit code ${result.status}`,
    );
  }
}

async function main() {
  const networkName = normalizeNetworkName(process.argv[2]);
  const deploymentPath =
    process.env.CONTRACTS_FILE?.trim() || defaultContractsFile(networkName);

  if (!process.env.ETHERSCAN_API_KEY?.trim()) {
    throw new Error(
      "ETHERSCAN_API_KEY must be set before running verification.",
    );
  }

  const deployment = JSON.parse(
    await readFile(deploymentPath, "utf8"),
  ) as DeploymentFile;
  if (deployment.network !== networkName) {
    console.warn(
      `Deployment file network is ${deployment.network}, but verification network is ${networkName}. Continuing with provided file.`,
    );
  }

  console.log(
    `Verifying MockUSDC at ${deployment.mockUSDC.address} on ${networkName}...`,
  );
  runHardhatVerify(networkName, [deployment.mockUSDC.address]);

  console.log(
    `Verifying CollateralVault at ${deployment.collateralVault.address} on ${networkName}...`,
  );
  runHardhatVerify(networkName, [
    deployment.collateralVault.address,
    deployment.mockUSDC.address,
    deployment.operator,
  ]);

  console.log("Verification completed.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
