import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreHeadline } from "../functions/api/sentiment.js";

const label = (h) => scoreHeadline(h).label;

test("clear negatives", () => {
  assert.equal(label("Bitcoin falls below $60,000 as the Nasdaq AI selloff drags crypto down"), "negative");
  assert.equal(label("Wrapped Monero token crashes 99.8% amid suspected $13.5M exploit"), "negative");
  assert.equal(label("Solana slips to $68 as ETF inflows give way to withdrawals"), "negative");
  assert.equal(label("Why is Ethereum price down 9% today?"), "negative");
});

test("clear positives", () => {
  assert.equal(label("Ethereum surges 12% as ETF inflows hit record high"), "positive");
  assert.equal(label("SEC approves spot XRP ETF"), "positive");
});

test("negation and concession", () => {
  assert.equal(label("Bitcoin fails to rally despite rate cut"), "negative");
  assert.equal(label("Ether falls despite record ETF inflows"), "negative");
  assert.equal(label("Bitcoin is not crashing, analysts say"), "neutral");
});

test("no signal is neutral", () => {
  assert.equal(label("Pepe Coin Price Prediction: What next?"), "neutral");
  assert.equal(label("What is a blockchain?"), "neutral");
});
