import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { artifacts, network } from "hardhat";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const EXPLORER_BASE_URL_BY_CHAIN_ID: Record<number, string> = {
  11155111: "https://sepolia.etherscan.io/address/",
  421614: "https://sepolia.arbiscan.io/address/",
};

const LOCAL_NETWORK_NAMES = new Set(["localhost", "hardhatMainnet"]);

type SavedContract = {
  address: Address;
  abi: unknown[];
};

type SavedDeployment = {
  chainId: number;
  network: string;
  deployer: Address;
  operator: Address;
  mockUSDC: SavedContract;
  collateralVault: SavedContract;
  deployedAt: string;
  deploymentBlock: string;
  explorer?: {
    mockUSDC?: string;
    collateralVault?: string;
  };
};

function defaultOutputPath(networkName: string): string {
  return networkName === "localhost"
    ? "backend/src/generated/contracts.json"
    : `backend/src/generated/contracts.${networkName}.json`;
}

function resolveOutputPath(networkName: string): string {
  return process.env.CONTRACTS_FILE?.trim() || defaultOutputPath(networkName);
}

function isLocalNetwork(networkName: string): boolean {
  return LOCAL_NETWORK_NAMES.has(networkName);
}

function normalizePrivateKey(privateKey: string): Hex {
  const trimmed = privateKey.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as Hex;
}

function resolveOperatorAddress(
  deployer: Address,
  networkName: string,
): Address {
  const explicitAddress = process.env.OPERATOR_ADDRESS?.trim();
  if (explicitAddress) {
    if (!isAddress(explicitAddress)) {
      throw new Error(`Invalid OPERATOR_ADDRESS: ${explicitAddress}`);
    }
    return getAddress(explicitAddress);
  }

  const privateKey = process.env.OPERATOR_PRIVATE_KEY?.trim();
  if (privateKey) {
    return getAddress(
      privateKeyToAccount(normalizePrivateKey(privateKey)).address,
    );
  }

  if (!isLocalNetwork(networkName)) {
    throw new Error(
      "OPERATOR_ADDRESS or OPERATOR_PRIVATE_KEY must be set for testnet deployments. Do not rely on deployer fallback outside localhost.",
    );
  }

  return deployer;
}

function buildExplorerLinks(
  chainId: number,
  mockUSDC: Address,
  collateralVault: Address,
) {
  const baseUrl = EXPLORER_BASE_URL_BY_CHAIN_ID[chainId];
  if (!baseUrl) return undefined;

  return {
    mockUSDC: `${baseUrl}${mockUSDC}`,
    collateralVault: `${baseUrl}${collateralVault}`,
  };
}

async function main() {
  const connection = await network.create();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployerClient] = await viem.getWalletClients();
  const networkName = connection.networkName;
  const outputPath = resolveOutputPath(networkName);

  if (!deployerClient?.account) {
    throw new Error("No deployer wallet client is available for this network.");
  }

  const chainId = await publicClient.getChainId();
  const deployer = getAddress(deployerClient.account.address);
  const operator = resolveOperatorAddress(deployer, networkName);

  console.log(`Deploying contracts to ${networkName} (chainId=${chainId})`);
  console.log(`Deployer: ${deployer}`);
  console.log(`Operator: ${operator}`);
  console.log(
    "Token: MockUSDC demo collateral only. Do not use real USDC with this reference implementation deploy script.",
  );

  const mockUSDC = await viem.deployContract("MockUSDC", [], {
    client: { wallet: deployerClient },
  });
  const mockUSDCAddress = getAddress(mockUSDC.address);
  console.log(`MockUSDC deployed at ${mockUSDCAddress}`);

  const collateralVault = await viem.deployContract(
    "CollateralVault",
    [mockUSDCAddress, operator],
    {
      client: { wallet: deployerClient },
    },
  );
  const collateralVaultAddress = getAddress(collateralVault.address);
  console.log(`CollateralVault deployed at ${collateralVaultAddress}`);
  console.log(`CollateralVault operator set to ${operator}`);

  const mockUSDCArtifact = await artifacts.readArtifact("MockUSDC");
  const collateralVaultArtifact =
    await artifacts.readArtifact("CollateralVault");
  const deploymentBlock = await publicClient.getBlockNumber();
  const explorer = buildExplorerLinks(
    chainId,
    mockUSDCAddress,
    collateralVaultAddress,
  );

  const deployment: SavedDeployment = {
    chainId,
    network: networkName,
    deployer,
    operator,
    mockUSDC: {
      address: mockUSDCAddress,
      abi: [...mockUSDCArtifact.abi],
    },
    collateralVault: {
      address: collateralVaultAddress,
      abi: [...collateralVaultArtifact.abi],
    },
    deployedAt: new Date().toISOString(),
    deploymentBlock: deploymentBlock.toString(),
    ...(explorer ? { explorer } : {}),
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(deployment, null, 2)}\n`,
    "utf8",
  );

  console.log(`Saved contract deployment to ${outputPath}`);
  if (explorer) {
    console.log("Explorer links:");
    console.log(`MockUSDC: ${explorer.mockUSDC}`);
    console.log(`CollateralVault: ${explorer.collateralVault}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
