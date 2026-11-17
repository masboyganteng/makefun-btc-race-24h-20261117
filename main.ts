/**
 * EMA Range Rider — a cbBTC trend/mean-reversion bot for make.fun.
 *
 * Protocol: agent-fun/bars-replay/v1. The harness sends one `hello` message,
 * then one `batch` per 1-minute `bar`, then `done`. The bot answers every
 * batch with exactly one `reply` echoing its seq, carrying its `orders`
 * (at most one open position, long only). Orders decided on a batch fill at
 * the next bar's open, so every decision uses only closes already seen.
 *
 * Strategy (chosen from the dev window's own data, 1440 one-minute bars):
 * the dev window is range-bound (BTC roughly 63.9k-65.5k, +0.49% over 24h)
 * with choppy 1-minute closes, so plain EMA crosses whipsaw and lose money
 * after the ~26 bps round-trip cost. Instead the bot rides the range with
 * two modes around a slow EMA-100 of closes:
 *
 *   - DIP (mean reversion): buy when the close falls 0.65% below the
 *     EMA-100, sell when it recovers to 0.55% above the EMA-100.
 *   - MOMENTUM: buy when the close pushes 1.0% above the EMA-100 (a real
 *     break-out, so a strongly trending race window still gets trades),
 *     sell when it falls back to 0.2% above the EMA-100 or on a 1.5%
 *     take-profit.
 *
 * Both modes share a hard stop-loss: sell if the close drops 1.0% below the
 * entry fill price. Sizing is 60% of equity per trade, one position at a
 * time, so a single bad trade can never draw the account down far.
 *
 * Determinism: no network, no wall clock, no files, no randomness. The EMA
 * is a pure function of the closes seen, and every decision is a pure
 * function of the bars, fills and account the harness sent. Two runs on the
 * same data produce byte-identical replies.
 */

import * as readline from "node:readline";

const SYMBOL = "CBBTC";

// Strategy parameters (fractions, tuned on the dev window's plateau).
const EMA_LEN = 100;
const DIP_ENTRY = 0.9935; // buy when close < EMA * DIP_ENTRY
const DIP_EXIT = 1.0055; // sell (dip mode) when close > EMA * DIP_EXIT
const MOM_ENTRY = 1.01; // buy when close > EMA * MOM_ENTRY
const MOM_EXIT = 1.002; // sell (momentum mode) when close < EMA * MOM_EXIT
const MOM_TAKE_PROFIT = 1.015; // sell (momentum mode) when close > entry * this
const STOP_LOSS = 0.99; // sell (either mode) when close < entry * this
const SIZE_FRACTION = 60; // percent of equity spent per buy
const MAX_SLIPPAGE_BPS = 100; // 1% guard vs the latest close
const MIN_BARS = 100; // need a full EMA window of closes before trading

type Order = Record<string, string | number>;

async function main(): Promise<void> {
  let ema: number | null = null; // EMA-100 of closes, in price units (1e-5 USD)
  let closesSeen = 0;
  let warmupBars = 0;
  let cash = 0;
  let equity = 0;
  let posQty = 0;
  let posCost = 0;
  let entryPrice: number | null = null; // fill price of the open position
  let entryMode: string | null = null; // "dip" or "mom"
  let pending: { id: string; side: string; mode: string | null } | null = null;
  let orderNo = 0;

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const text = line.trim();
    if (text === "") continue;
    const msg = JSON.parse(text) as Record<string, any>;
    const kind = msg["type"] as string;

    if (kind === "hello") {
      warmupBars = Number(msg["warmup_bars"] ?? 0);
      continue;
    }
    if (kind === "done") {
      return;
    }
    if (kind !== "batch") {
      continue;
    }

    const seq = Number(msg["seq"]);

    // Fold in this batch's bar: update the EMA from the latest close.
    let close: number | null = null;
    for (const bar of (msg["bars"] as any[]) ?? []) {
      if (bar["symbol"] !== SYMBOL) continue;
      close = Number(bar["c"]);
      if (ema === null) {
        ema = close;
      } else {
        ema += (2 / (EMA_LEN + 1)) * (close - ema);
      }
      closesSeen += 1;
    }

    // Fold in the account and the fills of the previous batch's orders.
    const account = (msg["account"] as Record<string, any>) ?? {};
    cash = Number(account["cash_quote_units"] ?? 0);
    equity = Number(account["equity_quote_units"] ?? 0);
    posQty = 0;
    posCost = 0;
    for (const p of (account["positions"] as any[]) ?? []) {
      if (p["symbol"] === SYMBOL) {
        posQty = Number(p["qty"]);
        posCost = Number(p["cost_quote_units"]);
      }
    }
    if (pending !== null) {
      for (const fill of (msg["fills"] as any[]) ?? []) {
        if (fill["client_id"] !== pending.id) continue;
        if (fill["status"] === "filled" && pending.side === "buy") {
          entryPrice = Number(fill["price"]);
          entryMode = pending.mode;
        }
        pending = null;
        break;
      }
    }
    if (posQty > 0 && entryPrice === null) {
      // Fallback: derive the entry price from the position's cost basis
      // (cost in 1e-6 USDC, qty in 1e-8 BTC, price in 1e-5 USD).
      entryPrice = Math.floor((posCost * 10 ** 7) / posQty);
      if (entryMode === null) entryMode = "dip";
    }
    if (posQty === 0) {
      entryPrice = null;
      entryMode = null;
    }

    const orders: Order[] = [];
    const warmingUp = seq < warmupBars;
    const ready =
      ema !== null && closesSeen >= MIN_BARS && !warmingUp && pending === null;
    if (ready && close !== null && ema !== null) {
      if (posQty === 0) {
        let mode: string | null = null;
        if (close < ema * DIP_ENTRY) {
          mode = "dip";
        } else if (close > ema * MOM_ENTRY) {
          mode = "mom";
        }
        if (mode !== null) {
          let notional = Math.floor((equity * SIZE_FRACTION) / 100);
          if (notional > cash) notional = cash;
          if (notional >= 1_000_000) {
            // at least 1 USDC
            orderNo += 1;
            const cid = "o" + orderNo;
            orders.push({
              side: "buy",
              client_id: cid,
              symbol: SYMBOL,
              notional_quote_units: String(notional),
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            });
            pending = { id: cid, side: "buy", mode };
          }
        }
      } else {
        let sell = false;
        if (entryPrice !== null && close < entryPrice * STOP_LOSS) {
          sell = true;
        } else if (entryMode === "dip" && close > ema * DIP_EXIT) {
          sell = true;
        } else if (entryMode === "mom") {
          if (close < ema * MOM_EXIT) {
            sell = true;
          } else if (entryPrice !== null && close > entryPrice * MOM_TAKE_PROFIT) {
            sell = true;
          }
        }
        if (sell) {
          orderNo += 1;
          const cid = "o" + orderNo;
          orders.push({
            side: "sell",
            client_id: cid,
            symbol: SYMBOL,
            qty: String(posQty),
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          pending = { id: cid, side: "sell", mode: null };
        }
      }
    }

    process.stdout.write(
      JSON.stringify({ type: "reply", seq, orders }) + "\n",
    );
  }
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
