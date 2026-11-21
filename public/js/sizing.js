// Position sizing: how much to buy so that hitting the stop-loss costs a fixed,
// chosen amount of the account. Pure functions, no DOM.

/** Largest share of the balance Entryvex will suggest for a single position. */
export const MAX_POSITION_PCT = 25;

/** Round DOWN to a multiple of step (exchange quantity rules). */
export function floorStep(value, step) {
  if (!step || step <= 0) return value;
  const decimals = stepDecimals(step);
  return +(Math.floor(value / step + 1e-9) * step).toFixed(decimals);
}

/** Round to the nearest multiple of tick (exchange price rules). */
export function roundTick(value, tick) {
  if (!tick || tick <= 0) return value;
  return +(Math.round(value / tick) * tick).toFixed(stepDecimals(tick));
}

export function stepDecimals(step) {
  const s = String(step);
  if (s.includes("e-")) return +s.split("e-")[1];
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.slice(i + 1).replace(/0+$/, "").length;
}

/**
 * @param o.balance      account cash available for trading (quote currency, e.g. USDT)
 * @param o.riskPct      percent of balance you accept losing if the stop is hit (e.g. 1 = 1%)
 * @param o.entry,o.stop,o.target  prices
 * @param o.costPerSide  fraction charged on buy and on sell (fee + half-spread)
 * @param o.rules        { stepSize, minQty, tickSize, minNotional }
 */
export function sizePosition(o) {
  const { balance, riskPct, entry, stop, target, costPerSide = 0, rules = {} } = o;
  const out = { ok: false };
  if (!(balance > 0) || !(riskPct > 0) || !(entry > 0) || !(stop > 0) || !(target > 0)) {
    out.reason = "missing";
    return out;
  }
  if (stop >= entry) { out.reason = "stop-above"; return out; }
  if (target <= entry) { out.reason = "target-below"; return out; }

  const e = roundTick(entry, rules.tickSize);
  const s = roundTick(stop, rules.tickSize);
  const t = roundTick(target, rules.tickSize);

  // Loss per $1 spent if the stop is hit: price drop + fee/spread on the buy and the sell.
  const lossPerDollar = (e - s) / e + 2 * costPerSide;
  const gainPerDollar = (t - e) / e - 2 * costPerSide;
  const riskBudget = balance * (riskPct / 100);

  // Never put more than maxPositionPct of the balance into one position (default 25%), even if the
  // stop is so close that risking riskPct would "allow" more. Concentration is a risk of its own.
  const maxSpend = balance * (o.maxPositionPct ?? MAX_POSITION_PCT) / 100;
  let spend = riskBudget / lossPerDollar;
  const capped = spend > maxSpend;
  if (capped) spend = maxSpend;

  let qty = floorStep(spend / e, rules.stepSize);
  spend = qty * e;

  out.entry = e; out.stop = s; out.target = t;
  out.qty = qty;
  out.spend = spend;
  out.capped = capped;
  out.maxSpend = maxSpend;
  out.riskBudget = riskBudget;
  out.lossUsd = spend * lossPerDollar;
  out.winUsd = spend * gainPerDollar;
  out.rr = gainPerDollar > 0 ? gainPerDollar / lossPerDollar : 0;
  out.breakevenWin = gainPerDollar > 0 ? lossPerDollar / (gainPerDollar + lossPerDollar) : 1;
  out.pctOfBalance = spend / balance;
  out.stopPct = (e - s) / e;
  out.targetPct = (t - e) / e;

  if (qty <= 0 || (rules.minQty && qty < rules.minQty) || (rules.minNotional && spend < rules.minNotional)) {
    out.reason = "too-small";
    out.minSpend = Math.max(rules.minNotional || 0, (rules.minQty || 0) * e);
    return out;
  }
  if (gainPerDollar <= 0) { out.reason = "costs-eat-target"; return out; }
  out.ok = true;
  return out;
}

/** Expected dollar result per trade from a measured win rate (wins at target, losses at stop). */
export function expectedUsd(sz, winRate) {
  if (!sz || !isFinite(winRate)) return NaN;
  return winRate * sz.winUsd - (1 - winRate) * sz.lossUsd;
}
