import type { Abi } from "viem";
import type { HexAddress } from "./domain.js";

export type ContractDeployment = {
  address: HexAddress | null;
  abi: Abi;
};

export type ContractsConfig = {
  chainId: number;
  network?: string;
  deployer?: HexAddress;
  operator?: HexAddress;
  mockUSDC: ContractDeployment;
  collateralVault: ContractDeployment;
  deployedAt: string | null;
  deploymentBlock: number | string | null;
};
