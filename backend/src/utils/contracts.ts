import { readFile } from "node:fs/promises";
import { getAddress, isAddress } from "viem";
import type { ContractsConfig } from "../types/contracts.js";

export async function loadContractsConfig(
  path: string,
): Promise<ContractsConfig> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as ContractsConfig;
}

export function hasUsableVaultDeployment(contracts: ContractsConfig): boolean {
  return Boolean(
    contracts.collateralVault.address &&
    isAddress(contracts.collateralVault.address) &&
    contracts.collateralVault.abi.length > 0,
  );
}

export function normalizeContractsConfig(
  contracts: ContractsConfig,
): ContractsConfig {
  return {
    ...contracts,
    mockUSDC: {
      ...contracts.mockUSDC,
      address: contracts.mockUSDC.address
        ? getAddress(contracts.mockUSDC.address)
        : null,
    },
    collateralVault: {
      ...contracts.collateralVault,
      address: contracts.collateralVault.address
        ? getAddress(contracts.collateralVault.address)
        : null,
    },
  };
}
