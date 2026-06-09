import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEventLogs } from "viem";
import { network } from "hardhat";

const { viem } = await network.create();

const USDC = 1_000_000n;

function bytes32(value: number): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

async function deployVaultFixture() {
  const [owner, alice, bob, operator] = await viem.getWalletClients();
  const token = await viem.deployContract("MockUSDC");
  const vault = await viem.deployContract("CollateralVault", [
    token.address,
    operator.account.address,
  ]);

  return { token, vault, owner, alice, bob, operator };
}

async function depositForAlice(amount: bigint) {
  const fixture = await deployVaultFixture();
  const { token, vault, alice } = fixture;

  await token.write.mint([alice.account.address, amount]);
  await token.write.approve([vault.address, amount], {
    account: alice.account,
  });
  await vault.write.deposit([amount], { account: alice.account });

  return fixture;
}

async function fundInsuranceForVault(
  fixture: Awaited<ReturnType<typeof deployVaultFixture>>,
  amount: bigint,
) {
  const { token, vault, owner } = fixture;
  await token.write.mint([owner.account.address, amount]);
  await token.write.approve([vault.address, amount], {
    account: owner.account,
  });
  await vault.write.fundInsurance([amount], { account: owner.account });
}

describe("CollateralVault", () => {
  it("deposits approved MockUSDC into the vault", async () => {
    const { token, vault, alice } = await deployVaultFixture();
    const amount = 10_000n * USDC;

    await token.write.mint([alice.account.address, amount]);
    await token.write.approve([vault.address, amount], {
      account: alice.account,
    });
    await vault.write.deposit([amount], { account: alice.account });

    assert.equal(await vault.read.balanceOf([alice.account.address]), amount);
    assert.equal(await vault.read.totalLiabilities(), amount);
    assert.equal(await token.read.balanceOf([vault.address]), amount);
    assert.equal(await token.read.balanceOf([alice.account.address]), 0n);
  });

  it("funds protocol insurance liquidity", async () => {
    const { token, vault, owner } = await deployVaultFixture();
    const amount = 500n * USDC;

    await token.write.mint([owner.account.address, amount]);
    await token.write.approve([vault.address, amount], {
      account: owner.account,
    });
    await vault.write.fundInsurance([amount], { account: owner.account });

    assert.equal(await vault.read.insuranceBalance(), amount);
    assert.equal(await vault.read.totalLiabilities(), 0n);
    assert.equal(await token.read.balanceOf([vault.address]), amount);
  });

  it("records a withdrawal request without transferring funds", async () => {
    const depositAmount = 10_000n * USDC;
    const requestAmount = 2_500n * USDC;
    const { token, vault, alice } = await depositForAlice(depositAmount);

    await vault.write.requestWithdraw([requestAmount], {
      account: alice.account,
    });

    assert.equal(
      await vault.read.pendingWithdrawals([alice.account.address]),
      requestAmount,
    );
    assert.equal(
      await vault.read.approvedWithdrawals([alice.account.address]),
      0n,
    );
    assert.equal(
      await vault.read.balanceOf([alice.account.address]),
      depositAmount,
    );
    assert.equal(await token.read.balanceOf([alice.account.address]), 0n);
    assert.equal(await token.read.balanceOf([vault.address]), depositAmount);
  });

  it("approves a pending withdrawal when called by the operator", async () => {
    const depositAmount = 10_000n * USDC;
    const requestAmount = 2_500n * USDC;
    const approvedAmount = 1_000n * USDC;
    const { vault, alice, operator } = await depositForAlice(depositAmount);

    await vault.write.requestWithdraw([requestAmount], {
      account: alice.account,
    });
    await vault.write.approveWithdraw([alice.account.address, approvedAmount], {
      account: operator.account,
    });

    assert.equal(
      await vault.read.pendingWithdrawals([alice.account.address]),
      requestAmount - approvedAmount,
    );
    assert.equal(
      await vault.read.approvedWithdrawals([alice.account.address]),
      approvedAmount,
    );
    assert.equal(
      await vault.read.balanceOf([alice.account.address]),
      depositAmount,
    );
  });

  it("rejects withdrawal approval from a non-operator account", async () => {
    const depositAmount = 10_000n * USDC;
    const requestAmount = 2_500n * USDC;
    const { vault, alice } = await depositForAlice(depositAmount);

    await vault.write.requestWithdraw([requestAmount], {
      account: alice.account,
    });

    await viem.assertions.revertWithCustomErrorWithArgs(
      vault.write.approveWithdraw([alice.account.address, requestAmount], {
        account: alice.account,
      }),
      vault,
      "NotOperator",
      [alice.account.address],
    );
  });

  it("withdraws only the operator-approved amount", async () => {
    const depositAmount = 10_000n * USDC;
    const requestAmount = 2_500n * USDC;
    const approvedAmount = 1_000n * USDC;
    const { token, vault, alice, operator } =
      await depositForAlice(depositAmount);

    await vault.write.requestWithdraw([requestAmount], {
      account: alice.account,
    });
    await vault.write.approveWithdraw([alice.account.address, approvedAmount], {
      account: operator.account,
    });

    await viem.assertions.revertWithCustomErrorWithArgs(
      vault.write.withdrawApproved([approvedAmount + 1n], {
        account: alice.account,
      }),
      vault,
      "InsufficientApprovedWithdrawal",
      [approvedAmount, approvedAmount + 1n],
    );

    await vault.write.withdrawApproved([approvedAmount], {
      account: alice.account,
    });

    assert.equal(
      await vault.read.balanceOf([alice.account.address]),
      depositAmount - approvedAmount,
    );
    assert.equal(
      await vault.read.totalLiabilities(),
      depositAmount - approvedAmount,
    );
    assert.equal(
      await vault.read.approvedWithdrawals([alice.account.address]),
      0n,
    );
    assert.equal(
      await token.read.balanceOf([alice.account.address]),
      approvedAmount,
    );
    assert.equal(
      await token.read.balanceOf([vault.address]),
      depositAmount - approvedAmount,
    );
  });

  it("does not allow direct withdrawal without approval", async () => {
    const depositAmount = 10_000n * USDC;
    const withdrawAmount = 1_000n * USDC;
    const { vault, alice } = await depositForAlice(depositAmount);

    await viem.assertions.revertWithCustomErrorWithArgs(
      vault.write.withdraw([withdrawAmount], { account: alice.account }),
      vault,
      "InsufficientApprovedWithdrawal",
      [0n, withdrawAmount],
    );
  });

  it("applies positive generic settlement when called by the operator", async () => {
    const depositAmount = 10_000n * USDC;
    const amountDelta = 250n * USDC;
    const fixture = await depositForAlice(depositAmount);
    const { token, vault, alice, operator } = fixture;

    await fundInsuranceForVault(fixture, amountDelta);

    await vault.write.settle(
      [alice.account.address, amountDelta, bytes32(1), bytes32(101)],
      {
        account: operator.account,
      },
    );

    assert.equal(
      await vault.read.balanceOf([alice.account.address]),
      depositAmount + amountDelta,
    );
    assert.equal(
      await vault.read.totalLiabilities(),
      depositAmount + amountDelta,
    );
    assert.equal(await vault.read.insuranceBalance(), 0n);
    assert.equal(
      await token.read.balanceOf([vault.address]),
      depositAmount + amountDelta,
    );
  });

  it("applies negative generic settlement when called by the operator", async () => {
    const depositAmount = 10_000n * USDC;
    const amountDelta = -300n * USDC;
    const { vault, alice, operator } = await depositForAlice(depositAmount);

    await vault.write.settle(
      [alice.account.address, amountDelta, bytes32(2), bytes32(102)],
      {
        account: operator.account,
      },
    );

    assert.equal(
      await vault.read.balanceOf([alice.account.address]),
      depositAmount + amountDelta,
    );
    assert.equal(
      await vault.read.totalLiabilities(),
      depositAmount + amountDelta,
    );
    assert.equal(await vault.read.insuranceBalance(), -amountDelta);
  });

  it("rejects reuse of a settlementId", async () => {
    const depositAmount = 10_000n * USDC;
    const firstPnl = 10n * USDC;
    const secondPnl = 5n * USDC;
    const settlementId = bytes32(6);
    const fixture = await depositForAlice(depositAmount);
    const { vault, alice, operator } = fixture;

    await fundInsuranceForVault(fixture, firstPnl + secondPnl);
    await vault.write.settle(
      [alice.account.address, firstPnl, settlementId, bytes32(106)],
      {
        account: operator.account,
      },
    );

    await viem.assertions.revertWithCustomErrorWithArgs(
      vault.write.settle(
        [alice.account.address, secondPnl, settlementId, bytes32(107)],
        {
          account: operator.account,
        },
      ),
      vault,
      "SettlementAlreadyUsed",
      [settlementId],
    );
  });

  it("emits settlementId and reasonHash in the settlement event", async () => {
    const depositAmount = 10_000n * USDC;
    const amountDelta = 25n * USDC;
    const settlementId = bytes32(7);
    const reasonHash = bytes32(107);
    const fixture = await depositForAlice(depositAmount);
    const { vault, alice, operator } = fixture;
    const publicClient = await viem.getPublicClient();

    await fundInsuranceForVault(fixture, amountDelta);
    const hash = await vault.write.settle(
      [alice.account.address, amountDelta, settlementId, reasonHash],
      {
        account: operator.account,
      },
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const logs = parseEventLogs({
      abi: vault.abi,
      logs: receipt.logs,
      eventName: "SettlementApplied",
    });

    assert.equal(logs.length, 1);
    const args = logs[0].args as {
      user: `0x${string}`;
      amountDelta: bigint;
      newBalance: bigint;
      settlementId: `0x${string}`;
      reasonHash: `0x${string}`;
    };
    assert.equal(args.user.toLowerCase(), alice.account.address.toLowerCase());
    assert.equal(args.amountDelta, amountDelta);
    assert.equal(args.newBalance, depositAmount + amountDelta);
    assert.equal(args.settlementId, settlementId);
    assert.equal(args.reasonHash, reasonHash);
  });

  it("keeps settlePnl as a legacy alias that also emits PnlSettled", async () => {
    const depositAmount = 10_000n * USDC;
    const amountDelta = 25n * USDC;
    const fixture = await depositForAlice(depositAmount);
    const { vault, alice, operator } = fixture;
    const publicClient = await viem.getPublicClient();

    await fundInsuranceForVault(fixture, amountDelta);
    const hash = await vault.write.settlePnl(
      [alice.account.address, amountDelta, bytes32(9), bytes32(109)],
      { account: operator.account },
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const logs = parseEventLogs({
      abi: vault.abi,
      logs: receipt.logs,
      eventName: "PnlSettled",
    });

    assert.equal(logs.length, 1);
    const args = logs[0].args as {
      user: `0x${string}`;
      pnl: bigint;
      newBalance: bigint;
      settlementId: `0x${string}`;
      reasonHash: `0x${string}`;
    };
    assert.equal(args.user.toLowerCase(), alice.account.address.toLowerCase());
    assert.equal(args.pnl, amountDelta);
    assert.equal(args.newBalance, depositAmount + amountDelta);
  });

  it("emits InsuranceUsed when positive settlement consumes insurance", async () => {
    const depositAmount = 10_000n * USDC;
    const amountDelta = 25n * USDC;
    const fixture = await depositForAlice(depositAmount);
    const { vault, alice, operator } = fixture;
    const publicClient = await viem.getPublicClient();

    await fundInsuranceForVault(fixture, amountDelta);
    const hash = await vault.write.settle(
      [alice.account.address, amountDelta, bytes32(8), bytes32(108)],
      {
        account: operator.account,
      },
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const logs = parseEventLogs({
      abi: vault.abi,
      logs: receipt.logs,
      eventName: "InsuranceUsed",
    });

    assert.equal(logs.length, 1);
    const args = logs[0].args as { user: `0x${string}`; amount: bigint };
    assert.equal(args.user.toLowerCase(), alice.account.address.toLowerCase());
    assert.equal(args.amount, amountDelta);
  });

  it("rejects settle from a non-operator account", async () => {
    const depositAmount = 10_000n * USDC;
    const amountDelta = 100n * USDC;
    const { vault, alice } = await depositForAlice(depositAmount);

    await viem.assertions.revertWithCustomErrorWithArgs(
      vault.write.settle(
        [alice.account.address, amountDelta, bytes32(3), bytes32(103)],
        {
          account: alice.account,
        },
      ),
      vault,
      "NotOperator",
      [alice.account.address],
    );
  });

  it("rejects negative settlement that would make the user balance negative", async () => {
    const depositAmount = 100n * USDC;
    const amountDelta = -101n * USDC;
    const { vault, alice, operator } = await depositForAlice(depositAmount);

    await viem.assertions.revertWithCustomErrorWithArgs(
      vault.write.settle(
        [alice.account.address, amountDelta, bytes32(4), bytes32(104)],
        {
          account: operator.account,
        },
      ),
      vault,
      "InsufficientBalance",
      [depositAmount, -amountDelta],
    );
  });

  it("rejects positive settlement if insurance is insufficient", async () => {
    const depositAmount = 100n * USDC;
    const amountDelta = 1n * USDC;
    const { vault, alice, operator } = await depositForAlice(depositAmount);

    await viem.assertions.revertWithCustomErrorWithArgs(
      vault.write.settle(
        [alice.account.address, amountDelta, bytes32(5), bytes32(105)],
        {
          account: operator.account,
        },
      ),
      vault,
      "InsufficientInsuranceBalance",
      [0n, amountDelta],
    );
  });
});
