import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  ERC3156_CALLBACK_SUCCESS,
  calculateFlashFee,
  calculateFeeSplit,
  DEFAULT_FEE_BPS
} from "@qmoosa/flashloan-protocol";

import {
  FlashLoanEngine
} from "@qmoosa/flashloan-engine";

import {
  FlashLoanClient,
  BaseFlashBorrower,
  generateKeyPair
} from "@qmoosa/flashloan-sdk";

test("1. Cross-repo Initialization & Mathematical Invariant Verification", () => {
  assert.equal(ERC3156_CALLBACK_SUCCESS, "0x439148f0bbc682ca079e46d6e2c2f0c1e3b820f1a2978069302701048fe0994b");
  assert.equal(DEFAULT_FEE_BPS, 9n);

  const fee = calculateFlashFee(10_000_000n, 9n);
  assert.equal(fee, 9000n);

  const split = calculateFeeSplit(fee, 3000n);
  assert.equal(split.protocolShare, 2700n);
  assert.equal(split.poolShare, 6300n);
  assert.equal(split.protocolShare + split.poolShare, fee);
});

class ArbitrageTradingBot extends BaseFlashBorrower {
  constructor(address = "0xArbitrageurContract") {
    super(address);
    this.totalBorrowed = 0n;
    this.totalFeePaid = 0n;
  }

  async executeOperation(initiator, token, amount, fee, data) {
    this.totalBorrowed += amount;
    this.totalFeePaid += fee;
    // Simulates successful arbitrage execution on decentralized exchanges
  }
}

test("2. End-to-End Multi-Repo Flash Loan Arbitrage Flow & LP Yield Accrual", async () => {
  const { publicKey } = generateKeyPair();
  const engine = new FlashLoanEngine(publicKey, "0xProtocolTreasury", 31337);
  engine.registerPoolDirect("USDC", 9n); // 9 bps fee

  const client = new FlashLoanClient(engine, 31337);

  // LP Provider deposits 10,000,000 USDC
  const deposit = client.deposit("0xLpProvider", "USDC", 10_000_000n);
  assert.equal(deposit.shares, 10_000_000n);
  assert.equal(client.getMaxFlashLoan("USDC"), 10_000_000n);

  // Instantiate flash borrower
  const bot = new ArbitrageTradingBot();
  bot.allowInitiator("0xArbitrageTrader");

  // Execute flash loan of 2,000,000 USDC
  const receipt = await client.flashLoan(bot, "USDC", 2_000_000n, "0xDexArbitrageParams", {
    initiator: "0xArbitrageTrader",
    simulateRepayment: () => true
  });

  assert.equal(receipt.success, true);
  assert.equal(receipt.amount, 2_000_000n);
  // Fee = 2,000,000 * 9 / 10,000 = 1,800 USDC
  assert.equal(receipt.fee, 1800n);
  // Protocol fee = 30% of 1,800 = 540 USDC
  assert.equal(receipt.protocolFeeAccrued, 540n);
  // Pool fee = 70% of 1,800 = 1,260 USDC
  assert.equal(receipt.poolFeeAccrued, 1260n);

  // Pool total liquidity now increased by 1,260 USDC fee
  const reserve = client.getReserve("USDC");
  assert.equal(reserve.totalLiquidity, 10_001_260n);
  assert.equal(reserve.accruedProtocolFees, 540n);

  // LP withdraws their 10,000,000 shares
  const withdrawal = client.withdraw("0xLpProvider", "USDC", 10_000_000n);
  // LP receives original 10,000,000 + 1,260 earned flash fee!
  assert.equal(withdrawal.amount, 10_001_260n);
  assert.equal(withdrawal.remainingShares, 0n);
});
