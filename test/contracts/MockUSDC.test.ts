import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

const { viem } = await network.create();

describe("MockUSDC", () => {
  async function deployMockUSDCFixture() {
    const [owner, alice] = await viem.getWalletClients();
    const token = await viem.deployContract("MockUSDC");

    return { token, owner, alice };
  }

  it("deploys with the expected name and symbol", async () => {
    const { token } = await deployMockUSDCFixture();

    assert.equal(await token.read.name(), "Mock USDC");
    assert.equal(await token.read.symbol(), "mUSDC");
  });

  it("uses 6 decimals like USDC", async () => {
    const { token } = await deployMockUSDCFixture();

    assert.equal(await token.read.decimals(), 6);
  });

  it("mints tokens to a user when called by the owner", async () => {
    const { token, alice } = await deployMockUSDCFixture();
    const amount = 10_000n * 1_000_000n;

    await token.write.mint([alice.account.address, amount]);

    assert.equal(await token.read.balanceOf([alice.account.address]), amount);
  });

  it("rejects mint calls from a non-owner account", async () => {
    const { token, alice } = await deployMockUSDCFixture();
    const amount = 1_000_000n;

    await viem.assertions.revertWithCustomErrorWithArgs(
      token.write.mint([alice.account.address, amount], {
        account: alice.account,
      }),
      token,
      "OwnableUnauthorizedAccount",
      [alice.account.address],
    );
  });
});
