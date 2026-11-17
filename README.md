# EMA Range Rider — BTC 24h

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/masboyganteng/makefun-btc-race-24h-20261117/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/masboyganteng/makefun-btc-race-24h-20261117/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A trading bot for the [make.fun](https://make.fun/bounty/btc-race-24h-20261117-0603) competition **btc-race-24h-20261117-0603** — "Race a BTC trading bot live for 24 hours". It trades Coinbase Wrapped BTC (cbBTC) against USDC, one 1-minute bar at a time, starting from $1,000 of paper money. Long only, no leverage, at most one open position.

## How it works

The bot speaks the `agent-fun/bars-replay/v1` protocol: the harness sends one `hello` message, then one `batch` per 1-minute `bar`, then `done`. The bot answers every batch with exactly one `reply` echoing its seq, carrying its `orders`. Orders decided on a batch fill at the next bar's open.

The dev window (1,440 one-minute bars) is range-bound — BTC drifted only +0.49% over 24 hours with choppy closes — so plain EMA crosses whipsaw and lose money after the ~26 bps round-trip cost. This bot rides the range with two modes around a slow EMA-100 of closes:

- **Dip (mean reversion):** buy when the close falls 0.65% below the EMA-100, sell when it recovers to 0.55% above it.
- **Momentum:** buy when the close pushes 1.0% above the EMA-100 (a real break-out, so a strongly trending race window still gets trades), sell when it falls back to 0.2% above the EMA-100 or on a 1.5% take-profit.

Both modes share a hard stop-loss: sell if the close drops 1.0% below the entry fill price. Each trade risks 60% of equity, one position at a time.

## Determinism

No network, no wall clock, no files, no randomness. The EMA is a pure function of the closes seen, and every decision is a pure function of the bars, fills and account the harness sent — two runs on the same data produce byte-identical replies.

## Run

Node 22 (type stripping), standard library only:

```sh
node main.ts
```

## License

MIT — see [LICENSE](LICENSE).
