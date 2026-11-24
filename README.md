[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/beeholde/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/beeholde/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Pump.fun Paper Sprint — Flash-Burst Sniper + Flat-Coin Filler

A paper-trading bot for the pump.fun 6-hour replay (agent-fun/replay/v2).
One program, `main.ts` on Node 22, no dependencies beyond the vendored
house shim (`vendor/makefun-bot.ts`).

## Strategy

Two tiers, one decision per coin, made on its create batch:

- **Tier 1 (snipe):** coins whose price is already +150% over create by the
  end of their create slot keep running often enough that buying them and
  selling into the spike wins. Buy up to 0.10 SOL, exit fast (+25%
  take-profit, −15% stop, 5-minute timeout).
- **Tier 2 (filler):** coins that barely move (+25% or less) are bought as
  cheaply as possible in small 0.005 SOL tickets topped up to 0.01 SOL, held
  long, purely to clear the 20-coin round-trip guardrail at minimum cost
  (+100% take-profit, −40% stop, 75-minute timeout).
- Mid-burst coins (+25%..+150%) are only bought as filler when the queue is
  nearly empty, so idle slots do not sit unused.
- **Catch-up:** once 5 hours have passed with fewer than 17 counted round
  trips, the filler net widens to +60% burst and the filler timeout shortens
  to 30 minutes, so the guardrail is met even on a quiet window. The trigger
  uses only the slot counter, so the run stays fully deterministic: no clocks,
  no randomness, same input, same replies.

## Clock

The replay's slot counter advances ~280 slots per minute of wall time
(measured on the dev dataset: 403,023 slots over 23.99 h of block time), not
the nominal 150. All timeouts in `main.ts` are counted in slots at that
measured rate.

## Run

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 over stdin/stdout: one `hello`, one
`batch` per slot, then `done`. Orders decided on the batch for slot *s*
fill at slot *s* + 2.

## License

MIT — see LICENSE.
