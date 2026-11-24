// Flash-burst sniper + fast guardrail filler for the pump.fun paper sprint.
//
// The replay speaks agent-fun/replay/v2 over stdin/stdout: one `hello` message
// with the capital, caps and fees, then one `batch` per slot carrying the
// slot's events, marks and fills, and finally `done`. This bot answers every
// batch with a `reply` holding its orders for that slot. Orders decided on the
// batch for slot s fill at slot s + 2, so everything here is decided on the
// reserves the batch just showed, never on a guess about the future.
//
// CLOCK: the replay's slot counter advances ~280 slots per minute of wall
// time (measured on the dev dataset: 403,023 slots over 23.99 h of block
// time), NOT the nominal 150. All timeouts below are counted in slots at
// that measured rate. (An earlier draft used 150 and every timeout fired
// ~1.87x early; the slot counter is the fix.)
//
// What the dev window taught (see NOTES.md for the numbers):
// - A coin's whole life is decided in its first minute. Most coins pump
//   10-30% in the slot they are created, then fade back toward their create
//   price over the next hour. Four out of five coins that complete do it in
//   the very slot they are created, so no bot can buy them.
// - The burst spike is BRIEF: coins at +150% over create run to a median
//   +45% above entry at some point, but the median coin is already -4% after
//   ~13 s and -21% after ~64 s. Take the profit fast (+20%) or the fade
//   takes it back. A +50% target or a 15-minute timeout both lose badly.
// - Only the most extreme bursts keep running: the +200% filter beats +150%,
//   and a wider -30% stop lets runners breathe. Bigger stakes amplify the
//   runners (the 1%-of-reserves cap binds first on most coins).
// - The filler is pure guardrail cost: the house needs 20 round trips of
//   >=0.01 SOL, and the guardrail has NO minimum hold time, so the cheapest
//   filler sells as soon as the 0.01 SOL floor is reached (price has barely
//   moved in ~1 min), paying only ~5% fees per round trip. Holding fillers
//   75 minutes costs ~0.13 SOL of fade per window; the fast filler costs
//   ~0.03 SOL. Exactly 21 filler buys (one spare), no mid-tier coins.
//
// Two tiers, one decision per coin, made on its create batch:
// - TIER 1 (snipe): burst >= +200% vs its create price. Buy up to 0.40 SOL
//   (capped at 1% of real reserves). Exit fast: +20% take-profit, -30%
//   stop, 5-minute timeout. This tier is the profit engine.
// - TIER 2 (filler): burst <= +25%. Queue it, buy 0.005 SOL when the size
//   cap allows, top up to 0.01 SOL total so the round trip counts toward the
//   guardrail, then sell ~1 minute after the floor is reached. Exit slow
//   only as a backstop: +100% take-profit, -40% stop, 75-minute timeout.
//   At most 21 filler buys per window, so the guardrail costs as little as
//   possible and leaves every slot it can to the snipe tier.
// - Mid coins (burst +25%..+200%) are never bought: they cost filler slots
//   for no edge.
// - Catch-up: once 5 hours (84,000 slots) have passed with fewer than 17
//   counted round trips, the filler queue also takes coins up to +60% burst
//   and the filler backstop shortens to 30 minutes, so the guardrail is met
//   even on a quiet window. The trigger uses only the slot counter, so the
//   run stays fully deterministic: no clocks, no randomness, same input,
//   same replies.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type SellInput,
} from "./vendor/makefun-bot.ts";

const SLOTS_PER_MIN = 280;
const MAX_SLIPPAGE_BPS = 10_000;

// Tier 1: the burst snipe.
const SNIPE_BURST = 2.0; // +200% over the create price, end of create slot
const SNIPE_STAKE = (LAMPORTS_PER_SOL * 40n) / 100n; // 0.40 SOL
const SNIPE_TP = 0.2;
const SNIPE_SL = 0.3;
const SNIPE_TIMEOUT_MIN = 5;

// Tier 2: the fast guardrail filler.
const FILL_BURST_MAX = 0.25; // +25% over the create price
const FILL_FIRST_BUY = (LAMPORTS_PER_SOL * 5n) / 1000n; // 0.005 SOL
const FILL_TARGET = (LAMPORTS_PER_SOL * 10n) / 1000n; // 0.01 SOL total
const FILL_EXIT_MIN = 1; // sell this soon after the 0.01 SOL floor is reached
const FILL_BACKSTOP_MIN = 75; // only for coins whose cap never grows to top up
const FILL_TP = 1.0;
const FILL_SL = 0.4;
const FILL_QUEUE_MIN = 60; // reconsider a queued coin for this long
const FILL_MAX_BUYS = 21; // guardrail needs 20 round trips; one spare

// Shared limits.
const MIN_BUY = FILL_FIRST_BUY; // smallest first buy the size cap must allow
const CATCHUP_SLOT = 84_000; // ~5h in, if behind pace, widen the filler net
const CATCHUP_MIN_TRIPS = 17;
const CATCHUP_BURST_MAX = 0.6;
const CATCHUP_BACKSTOP_MIN = 30;

interface CoinInfo {
  createPrice: number; // lamports of SOL per token at creation
  createSlot: number;
}

interface Position {
  tier: 1 | 2;
  costLamports: bigint; // quote spent on buy fills (curve fees included)
  tokens: bigint; // tokens currently held
  avgPrice: number; // lamports per token, volume-weighted over buy fills
  buySlot: number; // slot of the first buy fill
  buyPending: boolean;
  sellPending: boolean;
}

const coins = new Map<string, CoinInfo>();
const positions = new Map<string, Position>();
const queue: string[] = []; // tier-2 mints awaiting a free slot, oldest first
const queued = new Set<string>();
let firstSlot = -1;
let roundTrips = 0;
let fillBuys = 0; // tier-2 buys so far; the guardrail needs 20, one spare
let catchupOn = false;

function priceOf(state: BotState, mint: string): number | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.virtual_token_reserves === 0n) return null;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

function freeSlots(state: BotState): number {
  return state.hello.caps.max_open_positions - state.committedPositionCount();
}

async function main(): Promise<void> {
  await runBot({
    onBatch(state, batch) {
      try {
        return decide(state, batch);
      } catch (err) {
        // Never die on one bad batch: answer empty and keep replaying.
        console.error(`batch ${batch.seq}: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    },
  });
}

function decide(state: BotState, batch: Batch): Array<BuyInput | SellInput> {
  if (firstSlot < 0) firstSlot = batch.slot;
  const orders: Array<BuyInput | SellInput> = [];
  const txFee = state.txFeeLamports();
  let freeCash = state.freeCashLamports();

  // 1. Fold this batch's fills into the book.
  for (const fill of batch.fills) {
    const rec = positions.get(fill.mint);
    if (rec === undefined) continue;
    if (fill.side === "buy") {
      rec.buyPending = false;
      if (fill.status === "filled") {
        const spent = BigInt(fill.quote_lamports);
        const got = BigInt(fill.token_amount);
        if (got > 0n) {
          const prevCost = rec.costLamports;
          const prevTokens = rec.tokens;
          rec.costLamports = prevCost + spent;
          rec.tokens = prevTokens + got;
          const prevQuote = rec.avgPrice * Number(prevTokens);
          rec.avgPrice = (prevQuote + Number(spent)) / Number(rec.tokens);
          if (rec.buySlot < 0) rec.buySlot = fill.slot;
        }
      }
    } else {
      rec.sellPending = false;
      if (fill.status === "filled") {
        const sold = BigInt(fill.token_amount);
        rec.tokens = rec.tokens > sold ? rec.tokens - sold : 0n;
      }
    }
  }

  // Reconcile with the account: a position the account no longer holds has
  // closed (sold, completed, or flattened). Count it toward the guardrail
  // when its buy fills reached the 0.01 SOL floor. A record still waiting
  // for its first buy fill is not in the account yet, so leave it alone.
  for (const [mint, rec] of [...positions]) {
    if (rec.buyPending) continue;
    if (!state.positions.has(mint)) {
      if (rec.costLamports >= FILL_TARGET) roundTrips += 1;
      positions.delete(mint);
      queued.delete(mint);
    } else {
      rec.tokens = state.positions.get(mint)!.token_amount;
    }
  }

  // Catch-up: behind pace late in the window, widen the filler net.
  if (!catchupOn && batch.slot - firstSlot >= CATCHUP_SLOT && roundTrips < CATCHUP_MIN_TRIPS) {
    catchupOn = true;
  }
  const fillBurstMax = catchupOn ? CATCHUP_BURST_MAX : FILL_BURST_MAX;
  const fillBackstop = catchupOn ? CATCHUP_BACKSTOP_MIN : FILL_BACKSTOP_MIN;

  // 2. Note this batch's creations.
  const created: string[] = [];
  for (const event of batch.events) {
    if (event.event !== "CreateEvent") continue;
    const mint = event.mint;
    if (!coins.has(mint)) {
      const vTok = BigInt(event.virtual_token_reserves);
      const vSol = BigInt(event.virtual_quote_reserves);
      coins.set(mint, {
        createPrice: vTok === 0n ? 0 : Number(vSol) / Number(vTok),
        createSlot: event.slot,
      });
    }
    created.push(mint);
  }

  // 3. Exits first, so a freed slot can be reused by a buy in this same batch.
  for (const [mint, rec] of positions) {
    if (rec.tokens === 0n || rec.sellPending) continue;
    const price = priceOf(state, mint);
    if (price === null || rec.avgPrice <= 0) continue;
    const ret = price / rec.avgPrice - 1;
    const ageMin = (batch.slot - rec.buySlot) / SLOTS_PER_MIN;
    const tp = rec.tier === 1 ? SNIPE_TP : FILL_TP;
    const sl = rec.tier === 1 ? SNIPE_SL : FILL_SL;
    // Tier 2 sells as soon as the 0.01 SOL round-trip floor is reached (the
    // price has barely moved in ~1 min); the backstop only catches coins
    // whose size cap never grows enough to top up.
    const timedOut =
      rec.tier === 1
        ? ageMin >= SNIPE_TIMEOUT_MIN
        : (ageMin >= FILL_EXIT_MIN && rec.costLamports >= FILL_TARGET) ||
          ageMin >= fillBackstop;
    if (ret >= tp || ret <= -sl || timedOut) {
      orders.push({
        side: "sell",
        client_id: state.clientId(),
        mint,
        token_amount: rec.tokens.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      rec.sellPending = true;
      freeCash -= txFee;
    }
  }

  // 4. Top up tier-2 positions to the 0.01 SOL round-trip floor.
  for (const [mint, rec] of positions) {
    if (rec.tier !== 2 || rec.buyPending || rec.sellPending) continue;
    if (rec.costLamports >= FILL_TARGET || rec.tokens === 0n) continue;
    const cap = state.maxBuyLamports(mint);
    const add = FILL_TARGET - rec.costLamports < cap ? FILL_TARGET - rec.costLamports : cap;
    if (add < MIN_BUY) continue;
    if (freeCash < add + txFee) continue;
    orders.push({
      side: "buy",
      client_id: state.clientId(),
      mint,
      quote_lamports: add.toString(),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    rec.buyPending = true;
    freeCash -= add + txFee;
  }

  // 5. Classify this batch's creations, in event order.
  for (const mint of created) {
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    if (positions.has(mint) || queued.has(mint)) continue;
    const info = coins.get(mint);
    const curve = state.curves.get(mint);
    if (info === undefined || curve === undefined || curve.complete) continue;
    if (info.createPrice <= 0) continue;
    const now = priceOf(state, mint);
    if (now === null) continue;
    const burst = now / info.createPrice - 1;
    const cap = state.maxBuyLamports(mint);
    if (burst >= SNIPE_BURST) {
      if (freeSlots(state) <= 0 || cap < MIN_BUY) continue;
      const amount = SNIPE_STAKE < cap ? SNIPE_STAKE : cap;
      if (freeCash < amount + txFee) continue;
      orders.push({
        side: "buy",
        client_id: state.clientId(),
        mint,
        quote_lamports: amount.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      positions.set(mint, {
        tier: 1,
        costLamports: 0n,
        tokens: 0n,
        avgPrice: 0,
        buySlot: -1,
        buyPending: true,
        sellPending: false,
      });
      freeCash -= amount + txFee;
    } else if (burst <= fillBurstMax) {
      // Filler candidate, but only while the guardrail still needs buys.
      if (fillBuys < FILL_MAX_BUYS) {
        queue.push(mint);
        queued.add(mint);
      }
    }
    // Mid-burst coins (burst +25%..+200%) are never bought: they cost filler
    // slots for no edge.
  }

  // 6. Work the filler queue, oldest first.
  let scanned = 0;
  while (queue.length > 0 && scanned < 50) {
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    if (freeSlots(state) <= 0) break;
    const mint = queue[0]!;
    scanned += 1;
    const info = coins.get(mint);
    const curve = state.curves.get(mint);
    if (
      info === undefined ||
      curve === undefined ||
      curve.complete ||
      batch.slot - info.createSlot > FILL_QUEUE_MIN * SLOTS_PER_MIN ||
      positions.has(mint)
    ) {
      queue.shift();
      queued.delete(mint);
      continue;
    }
    const cap = state.maxBuyLamports(mint);
    if (cap < MIN_BUY) {
      // Its cap may still grow; leave it queued and look at the next one.
      queue.shift();
      queue.push(mint);
      continue;
    }
    const amount = FILL_FIRST_BUY < cap ? FILL_FIRST_BUY : cap;
    if (freeCash < amount + txFee) break;
    orders.push({
      side: "buy",
      client_id: state.clientId(),
      mint,
      quote_lamports: amount.toString(),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    positions.set(mint, {
      tier: 2,
      costLamports: 0n,
      tokens: 0n,
      avgPrice: 0,
      buySlot: -1,
      buyPending: true,
      sellPending: false,
    });
    fillBuys += 1;
    queue.shift();
    queued.delete(mint);
    freeCash -= amount + txFee;
  }

  return orders;
}

await main();
