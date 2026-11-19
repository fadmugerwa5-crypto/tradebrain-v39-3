/**
 * Basket sizing (pure). A basket is several identical entries opened together and closed together.
 * The total position is sized so the wanted bounce pays `targetUsd` after costs and the failure point loses at most `maxLossUsd`.
 */
import { pickMultiplier, planTrade } from "./bounce.ts";

export type Leg = { mult: number; stake: number; notional: number; stopLoss: number; takeProfit: number };
export type BasketPlan = {
  ok: true;
  legs: Leg[];
  /** price move that pays the target, as a fraction of price */
  moveFrac: number;
  stopFrac: number;
  notional: number;
  /** money the whole basket nets when the bounce arrives (after costs) */
  targetNet: number;
  /** money the whole basket loses if the idea fails (including costs) */
  maxLoss: number;
};
export type BasketRefusal = { ok: false; why: string };

export function planBasket(a: {
  price: number;
  /** range of the live candle (price units) */
  range: number;
  bounceFrac: number;
  stopFrac: number;
  legs: number;
  targetUsd: number;
  maxLossUsd: number;
  minNetUsd: number;
  costFrac: number;
  options: number[];
}): BasketPlan | BasketRefusal {
  const legsN = Math.max(1, Math.round(a.legs));
  const plan = planTrade({ price: a.price, lo: 0, hi: a.range, cfg: { entryLevel: 0, targetLevel: a.bounceFrac * 100, stopLevel: -a.stopFrac * 100 }, targetNetUsd: a.targetUsd, maxLossUsd: a.maxLossUsd, minNetUsd: a.minNetUsd, costFrac: a.costFrac });
  if (!plan) return { ok: false, why: `the bounce (${((a.bounceFrac * a.range) / a.price * 100).toFixed(3)}% of price) does not beat Deriv's cost (${(a.costFrac * 100).toFixed(3)}%)` };
  const m = pickMultiplier(a.options, plan.notional / legsN, plan.stopLoss / legsN, 1);
  if (!m) return { ok: false, why: "no usable multiplier" };
  const legStop = m.notional * plan.stopFrac;
  if (m.stake < legStop * 1.05) return { ok: false, why: "stake too small for the stop loss" };
  const legs: Leg[] = Array.from({ length: legsN }, () => ({ mult: m.mult, stake: m.stake, notional: m.notional, stopLoss: legStop, takeProfit: m.notional * plan.moveFrac * 2 }));
  const notional = m.notional * legsN;
  const targetNet = notional * (plan.moveFrac - a.costFrac);
  const maxLoss = notional * (plan.stopFrac + a.costFrac);
  if (maxLoss > a.maxLossUsd * 1.25) return { ok: false, why: `the minimum stakes would risk ${maxLoss.toFixed(2)} (limit ${a.maxLossUsd.toFixed(2)})` };
  if (targetNet < a.minNetUsd) return { ok: false, why: `expected net ${targetNet.toFixed(2)} is below the minimum ${a.minNetUsd.toFixed(2)}` };
  return { ok: true, legs, moveFrac: plan.moveFrac, stopFrac: plan.stopFrac, notional, targetNet, maxLoss };
}

/** Size multiplier: +step after each winning basket, back to 1 after a loss, never above max. */
export function nextScale(scale: number, won: boolean, step: number, max: number) {
  return won ? Math.min(max, Math.round((scale + step) * 100) / 100) : 1;
}
