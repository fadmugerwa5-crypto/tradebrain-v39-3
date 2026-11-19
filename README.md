# Jump Scalper — live-candle pullback

Demo-only Deriv scalper. **Scalp the pullback inside the live candle.**

- **Basket mode (default): buy the dump, close the whole stack on the bounce.** When a live candle spikes (bigger than a typical candle) and price dumps to the candle's low and ticks back up, the bot opens several entries at once (default 5). If the candle pumps to its high and ticks back down, it opens SELL entries. As soon as the *total* profit of the stack reaches its target, every entry is closed together. The stack is also closed together if its total loss reaches the cap, or after 120 s.
- **Size up after wins:** each winning basket makes the next one 25% bigger (up to 4x); any losing basket resets to 1x.
- **Pullback mode (option):** one trade per candle. 100 = the live candle's high so far, 0 = its low. BUY when a rising candle pulls back to ~80 and ticks up (target ~95, stop ~62); SELL is the mirror.
- **Live candle:** timeframe 1m / 2m / 5m / 15m, or Auto (best of 1m and 5m per market).
- **Scanner:** ranks every Deriv market by candle *instability* (swings per candle, wicks, no one-way trend) and trades only the most unstable ones. Each market card shows the share of past setups that paid in a replay of its last 20 candles.
- **Execution:** Deriv multiplier contracts on your **demo** account. The basket's total size is chosen so the bounce pays about $1.50 at 1x after costs and the failure point loses at most $3 (both scale with the size multiplier). Deriv's own cost quote is checked before sizing. Each entry also carries a stop loss and take profit held by Deriv, so the stack is protected even if the app closes. The journal records each basket as ONE trade.
- **Safety:** demo accounts only (real accounts are refused), daily loss limit, per-market cooldown, a cap on basket size, markets with a poor record of real trades are skipped.

## Honest caveat
Synthetic indices are random by design. In a replay on random jump-style data, only about 40-55% of spike setups reached the bounce target, while break-even needs about 63-71%, so the basket method has no proven edge. Judge it on the Journal tab after a few hundred demo baskets (profit factor > 1 after costs).

## Develop
`npm test` runs the strategy tests. `npm run dev` starts the app. Builds: Android APK and Windows EXE via GitHub Actions.
