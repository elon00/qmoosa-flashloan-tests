import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ERC3156_CALLBACK_SUCCESS
} from "@qmoosa/flashloan-protocol";

import {
  FlashLoanEngine
} from "@qmoosa/flashloan-engine";

import {
  FlashLoanClient,
  BaseFlashBorrower,
  generateKeyPair,
  signAdminIntent
} from "@qmoosa/flashloan-sdk";

function setupHarness() {
  const { publicKey, privateKey } = generateKeyPair();
  const engine = new FlashLoanEngine(publicKey, "0xProtocolTreasury", 31337);
  engine.registerPoolDirect("USDC", 9n);
  const client = new FlashLoanClient(engine, 31337);
  client.deposit("0xWhaleLp", "USDC", 10_000_000n);
  return { engine, client, publicKey, privateKey };
}

test("Negative Control 1: Reentrancy attack during callback strictly fails closed", async () => {
  const { client } = setupHarness();

  const maliciousBorrower = {
    address: "0xReentrancyAttacker",
    async onFlashLoan(initiator, token, amount, fee, data) {
      // Malicious attempt to borrow again during callback
      await client.flashLoan(this, token, amount, data);
      return ERC3156_CALLBACK_SUCCESS;
    }
  };

  await assert.rejects(
    () => client.flashLoan(maliciousBorrower, "USDC", 1_000_000n),
    /REENTRANCY_GUARD_TRIGGERED/
  );

  // Reserve balance strictly preserved
  assert.equal(client.getMaxFlashLoan("USDC"), 10_000_000n);
});

test("Negative Control 2: Invalid callback return hash reverts atomically", async () => {
  const { client } = setupHarness();

  const bogusBorrower = {
    address: "0xBogusBorrower",
    async onFlashLoan() {
      return "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    }
  };

  await assert.rejects(
    () => client.flashLoan(bogusBorrower, "USDC", 1_000_000n),
    /ERC3156_CALLBACK_FAILED/
  );

  assert.equal(client.getMaxFlashLoan("USDC"), 10_000_000n);
});

test("Negative Control 3: Insolvent borrower repayment failure triggers zero-mutation rollback", async () => {
  const { client } = setupHarness();

  const insolventBorrower = {
    address: "0xInsolventBorrower",
    async onFlashLoan() {
      return ERC3156_CALLBACK_SUCCESS;
    }
  };

  await assert.rejects(
    () =>
      client.flashLoan(insolventBorrower, "USDC", 5_000_000n, "", {
        simulateRepayment: () => false // Simulation proves borrower did not return funds
      }),
    /REPAYMENT_INSUFFICIENT_OR_FAILED/
  );

  assert.equal(client.getMaxFlashLoan("USDC"), 10_000_000n);
});

test("Negative Control 4: Excessive borrow exceeding available liquidity strictly rejected", async () => {
  const { client } = setupHarness();

  const normalBorrower = {
    address: "0xNormalBorrower",
    async onFlashLoan() {
      return ERC3156_CALLBACK_SUCCESS;
    }
  };

  await assert.rejects(
    () => client.flashLoan(normalBorrower, "USDC", 10_000_001n),
    /INSUFFICIENT_LIQUIDITY/
  );
});

test("Negative Control 5: Untrusted initiator rejected by borrower access control", async () => {
  class ProtectedBorrower extends BaseFlashBorrower {
    async executeOperation() {}
  }

  const borrower = new ProtectedBorrower("0xProtectedVault");
  borrower.allowInitiator("0xWhitelistedAdmin");

  await assert.rejects(
    () => borrower.onFlashLoan("0xMaliciousInitiator", "USDC", 1_000_000n, 900n, ""),
    /Untrusted initiator/
  );
});

test("Negative Control 6: Nonce replay for administrative intent strictly fails closed", () => {
  const { client, privateKey } = setupHarness();

  const intent = signAdminIntent(
    "SET_FEE_BPS",
    { token: "USDC", feeBps: 12 },
    1,
    Math.floor(Date.now() / 1000) + 300,
    "QMOOSA:FLASHLOAN:31337",
    privateKey
  );

  // First application succeeds
  client.signAndExecuteAdminIntent("SET_FEE_BPS", { token: "USDC", feeBps: 12 }, privateKey, 1);
  assert.equal(client.getReserve("USDC").feeBps, 12n);

  // Second application with same nonce must be rejected
  assert.throws(
    () => client.signAndExecuteAdminIntent("SET_FEE_BPS", { token: "USDC", feeBps: 12 }, privateKey, 1),
    /Nonce replay rejected/
  );
});

test("Negative Control 7: Forged administrative signature fails closed", () => {
  const { engine } = setupHarness();
  const { privateKey: attackerKey } = generateKeyPair();

  const forgedIntent = signAdminIntent(
    "SET_FEE_BPS",
    { token: "USDC", feeBps: 999 },
    10,
    Math.floor(Date.now() / 1000) + 300,
    "QMOOSA:FLASHLOAN:31337",
    attackerKey
  );

  assert.throws(
    () => engine.executeAdminIntent(forgedIntent),
    /Cryptographic verification failed/
  );
});

test("Negative Control 8: Absent repayment options fails closed with immediate rollback (P0)", async () => {
  const { client } = setupHarness();

  const nonRepayingBorrower = {
    address: "0xNonRepayingBorrower",
    async onFlashLoan() {
      // Returns valid ERC-3156 success hash but does not repay
      return ERC3156_CALLBACK_SUCCESS;
    }
  };

  // Calling without any repayment options MUST fail closed
  await assert.rejects(
    () => client.flashLoan(nonRepayingBorrower, "USDC", 2_000_000n),
    /REPAYMENT_INSUFFICIENT_OR_FAILED/
  );

  // Liquidity is completely preserved with zero mutation
  assert.equal(client.getMaxFlashLoan("USDC"), 10_000_000n);
});

