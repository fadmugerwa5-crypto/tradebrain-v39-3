import { useEffect, useState, type ReactNode } from "react";
import { closeAll, connect, patchSettings, setTrading, start, testTrade, type Settings } from "@/engine";
import { allowBackground, keepAliveAvailable } from "@/lib/keepalive";
import { Logo } from "@/components/logo";
import { useStore } from "@/ui";
import { ChartView, Journal, Markets, Scanner, Trades, money } from "@/views";
import { select } from "@/engine";

type Tab = "scanner" | "markets" | "chart" | "trades" | "journal" | "settings";

const ICONS: Record<Tab, ReactNode> = {
  scanner: <path d="M4 20V10M10 20V4M16 20v-8M22 20V8" />,
  markets: <path d="M4 6h16M4 12h16M4 18h10" />,
  chart: <path d="M3 17l5-6 4 3 8-10" />,
  trades: <path d="M7 4v14m0 0l-3-3m3 3l3-3M17 20V6m0 0l-3 3m3-3l3 3" />,
  journal: <path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h4" />,
  settings: <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M8 14v6" />,
};

export function App() {
  const s = useStore();
  const [tab, setTab] = useState<Tab>("scanner");
  useEffect(() => {
    void start();
  }, []);
  const open = (symbol: string) => {
    select(symbol);
    setTab("chart");
  };
  const tabs: [Tab, string][] = [["scanner", "Scanner"], ["markets", "Markets"], ["chart", "Chart"], ["trades", "Trades"], ["journal", "Journal"], ["settings", "Settings"]];
  const day = s.dayPnl;
  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col pb-28">
      <header className="px-4 pt-3">
        <div className="navy-card rounded-lg p-4">
          <div className="flex items-center gap-3">
            <Logo size={40} spin={s.trading} />
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-semibold leading-tight">Jump Scalper</h1>
              <p className="truncate text-xs text-white/70">
                <span className={s.account.connected ? "text-emerald-300" : "text-amber-300"}>●</span>{" "}
                {s.account.connected ? `Deriv demo ${s.account.loginid}` : "Watching only · not connected to a trading account"}
              </p>
            </div>
            <div className="text-right">
              <div className="text-lg font-semibold tabular-nums">{s.account.balance != null ? s.account.balance.toFixed(2) : "—"}</div>
              <div className={`text-xs ${day >= 0 ? "text-emerald-300" : "text-red-300"}`}>today {money(day)}</div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setTrading(!s.trading)} className={`h-11 rounded-full text-sm font-medium ${s.trading ? "bg-white text-[#0e2f5c]" : "bg-aqua text-[#0e2f5c]"}`}>
              {s.trading ? "Stop trading" : "Start trading"}
            </button>
            <button type="button" onClick={() => void closeAll()} disabled={!s.positions.length} className="h-11 rounded-full border border-red-300 text-sm font-medium text-red-200 disabled:opacity-40">
              Close ALL ({s.positions.length})
            </button>
          </div>
          <p className="mt-3 text-xs text-white/80">{s.status === "loading" ? "Loading Deriv markets…" : s.blocker}</p>
          <p className="text-xs text-white/50">{s.note}{s.feed.withHistory < s.feed.markets && s.feed.markets > 0 ? ` · history ${s.feed.withHistory}/${s.feed.markets}` : ""}</p>
          {s.error && <p className="mt-2 rounded-md bg-red-500/20 p-2 text-xs text-red-100">{s.error}</p>}
        </div>
      </header>
      <main className="flex-1 px-4 pt-3">
        {tab === "scanner" && <Scanner rows={s.rows} onOpen={open} />}
        {tab === "markets" && <Markets rows={s.rows} positions={s.positions} onOpen={open} />}
        {tab === "chart" && <ChartView rows={s.rows} positions={s.positions} selected={s.selected} />}
        {tab === "trades" && <Trades positions={s.positions} baskets={s.baskets} scale={s.scale} />}
        {tab === "journal" && <Journal trades={s.trades} journal={s.journal} day={s.dayPnl} />}
        {tab === "settings" && <SettingsTab st={s.settings} connected={s.account.connected} balance={s.account.balance} />}
      </main>
      <nav className="glass fixed inset-x-3 bottom-3 z-10 mx-auto flex max-w-2xl gap-1 rounded-lg p-1.5" style={{ marginBottom: "env(safe-area-inset-bottom, 0px)" }}>
        {tabs.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setTab(id)} className={`relative flex h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] ${tab === id ? "bg-accent/10 font-medium text-accent" : "text-faint"}`}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[id]}</svg>
            {label}
            {id === "trades" && s.positions.length > 0 && <span className="absolute right-2 top-1 rounded-full bg-down px-1.5 text-[10px] text-white">{s.positions.length}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}

function Num({ label, hint, value, onChange, step = 1 }: { label: string; hint?: string; value: number; onChange: (n: number) => void; step?: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span>{label}</span>
      <input inputMode="decimal" step={step} value={text} onChange={(e) => { setText(e.target.value); const n = Number(e.target.value); if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(n); }} className="h-11 rounded-md border border-line bg-elev px-3" />
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="glass flex flex-col gap-3 rounded-lg p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function SettingsTab({ st, connected, balance }: { st: Settings; connected: boolean; balance: number | null }) {
  const set = (p: Partial<Settings>) => patchSettings(p);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <Section title="Connect your Deriv demo account">
        <p className="text-xs leading-relaxed text-muted">Markets and prices load without logging in. Your token and App ID are only needed to place trades on your demo account.</p>
        <label className="flex flex-col gap-1 text-sm">
          <span>API token (Trade scope, from your demo account)</span>
          <input type="password" autoComplete="off" value={st.token} onChange={(e) => set({ token: e.target.value.replace(/\s/g, "") })} className="h-11 rounded-md border border-line bg-elev px-3" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>App ID (register a free app at developers.deriv.com)</span>
          <input inputMode="numeric" autoComplete="off" value={st.appId} onChange={(e) => set({ appId: e.target.value.replace(/[^A-Za-z0-9]/g, "") })} className="h-11 rounded-md border border-line bg-elev px-3" />
        </label>
        <button type="button" disabled={busy || !st.token || !st.appId} onClick={async () => { setBusy(true); await connect(); setBusy(false); }} className="h-11 rounded-md bg-accent text-sm font-medium text-accent-fg disabled:opacity-40">
          {busy ? "Connecting…" : connected ? `Connected · balance ${balance?.toFixed(2) ?? "—"} · reconnect` : "Connect"}
        </button>
        <button type="button" disabled={!connected} onClick={() => void testTrade()} className="h-11 rounded-md border border-line text-sm disabled:opacity-40">Place a $1 test trade on demo</button>
        <p className="text-xs text-muted">The test trade checks that orders reach your demo account. Deriv's exact reply (accepted or rejected, and why) appears in Journal → Event log.</p>
        {keepAliveAvailable() && <button type="button" className="h-11 rounded-md border border-line text-sm" onClick={() => void allowBackground()}>Allow running in the background</button>}
        <p className="text-xs text-muted">Stored only on this device. Demo accounts only: real accounts are refused.</p>
      </Section>

      <Section title="Strategy">
        <label className="flex flex-col gap-1 text-sm">
          <span>Mode</span>
          <select value={st.mode} onChange={(e) => set({ mode: e.target.value as Settings["mode"] })} className="h-11 rounded-md border border-line bg-elev px-3">
            <option value="basket">Basket: stack entries at the spike extreme, close all on the bounce</option>
            <option value="pullback">Pullback: one trade, buy the dip from the candle high</option>
          </select>
        </label>
        {st.mode === "basket" && (
          <>
            <p className="text-xs leading-relaxed text-muted">When a live candle spikes and dumps to its low, the bot opens several buys together (sells when it pumps to its high). The moment the whole basket is in profit it closes every entry at once, then starts again slightly bigger after each win.</p>
            <Num label="Entries per basket" value={st.legs} onChange={(legs) => set({ legs: Math.max(1, Math.min(10, Math.round(legs))) })} />
            <Num label="Bounce wanted (share of the candle's range)" value={st.bounceFrac} step={0.01} onChange={(bounceFrac) => set({ bounceFrac })} hint="0.15 = the basket closes after price recovers 15% of the candle's size." />
            <Num label="Give up when price moves against it (share of range)" value={st.stopFrac} step={0.01} onChange={(stopFrac) => set({ stopFrac })} />
            <Num label="Spike size needed (x a typical candle)" value={st.spikeMult} step={0.1} onChange={(spikeMult) => set({ spikeMult })} />
            <Num label="Entry zone (points from the candle's extreme, 0-100)" value={st.dumpZone} onChange={(dumpZone) => set({ dumpZone })} />
            <Num label="Size up after each win (0.25 = +25%)" value={st.scaleStep} step={0.05} onChange={(scaleStep) => set({ scaleStep })} />
            <Num label="Biggest size (x the base size)" value={st.scaleMax} step={0.5} onChange={(scaleMax) => set({ scaleMax: Math.max(1, scaleMax) })} hint="Size resets to 1x after any losing basket." />
            <Num label="Baskets open at once" value={st.maxBaskets} onChange={(maxBaskets) => set({ maxBaskets: Math.max(1, Math.min(5, Math.round(maxBaskets))) })} />
            <Num label="Close the basket after (seconds)" value={st.basketHoldSec} onChange={(basketHoldSec) => set({ basketHoldSec })} />
          </>
        )}
      </Section>

      <Section title="Which markets may trade">
        <label className="flex flex-col gap-1 text-sm">
          <span>Candle timeframe</span>
          <select value={st.timeframe} onChange={(e) => set({ timeframe: Number(e.target.value) })} className="h-11 rounded-md border border-line bg-elev px-3">
            <option value={0}>Auto (best of 1 min and 5 min per market)</option>
            <option value={60}>1 minute</option>
            <option value={120}>2 minutes</option>
            <option value={300}>5 minutes</option>
            <option value={900}>15 minutes</option>
          </select>
        </label>
        <Num label="Minimum instability score (0-100)" value={st.minInstability} onChange={(minInstability) => set({ minInstability })} hint="How much the candles swing up and down instead of running one way. Calmer markets are skipped." />
        <Num label="Trade only the most unstable N markets" value={st.watchTop} onChange={(watchTop) => set({ watchTop: Math.max(1, Math.round(watchTop)) })} />
        {st.mode === "pullback" && <Num label="Live candle must move at least (x typical candle)" value={st.minRangeMult} step={0.1} onChange={(minRangeMult) => set({ minRangeMult })} hint="A fresh candle has almost no range, so 80 means nothing yet. Below this the bot waits." />}
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Strict mode<br /><span className="text-xs text-muted">Only markets whose own recent candles prove the pullback paid. Safer, far fewer trades.</span></span>
          <input type="checkbox" checked={st.requireProof} onChange={(e) => set({ requireProof: e.target.checked })} className="h-6 w-6" />
        </label>
        <Num label="Past pullbacks needed (strict mode)" value={st.minEvents} onChange={(minEvents) => set({ minEvents })} />
        <Num label="Minimum share that reached the target (strict mode)" value={st.minHitRate} step={0.05} onChange={(minHitRate) => set({ minHitRate })} hint="With 80/95/62 you need above 0.55 just to break even." />
      </Section>

      {st.mode === "pullback" && <Section title="Pullback levels (100 = live candle high so far, 0 = its low)">
        <Num label="Entry level (buy on the pullback to here)" value={st.entryLevel} onChange={(entryLevel) => set({ entryLevel })} hint="SELL trades use the mirror levels when the candle is falling." />
        <Num label="Target level (take profit)" value={st.targetLevel} onChange={(targetLevel) => set({ targetLevel })} />
        <Num label="Stop level" value={st.stopLevel} onChange={(stopLevel) => set({ stopLevel })} />
        <Num label="Close trades this many seconds before the candle ends" value={st.closeBufferSec} onChange={(closeBufferSec) => set({ closeBufferSec: Math.max(0, closeBufferSec) })} hint="The 0-100 scale resets when a candle closes. No new trades start this close to the end either." />
        <Num label="Max hold seconds" value={st.maxHoldSec} onChange={(maxHoldSec) => set({ maxHoldSec })} />
      </Section>}

      <Section title="Size and risk">
        <Num label={st.mode === "basket" ? "Net profit wanted per basket at 1x size ($)" : "Net profit wanted per trade ($)"} value={st.targetNetUsd} onChange={(targetNetUsd) => set({ targetNetUsd })} hint="Position size is chosen so the target pays this after costs." />
        <Num label={st.mode === "basket" ? "Most one basket may lose at 1x size ($)" : "Most one trade may lose ($)"} value={st.maxLossUsd} onChange={(maxLossUsd) => set({ maxLossUsd })} />
        <Num label="Skip trades netting less than ($)" value={st.minNetUsd} onChange={(minNetUsd) => set({ minNetUsd })} />
        <Num label="Fallback cost, fraction of size" value={st.costFrac} step={0.0001} onChange={(costFrac) => set({ costFrac })} hint="Used only when Deriv gives no quote. Normally the real quote is used." />
        {st.mode === "pullback" && <Num label="Trades open at once" value={st.maxOpen} onChange={(maxOpen) => set({ maxOpen: Math.max(1, Math.min(10, Math.round(maxOpen))) })} />}
        <Num label="Daily loss limit ($)" value={st.dailyLossUsd} onChange={(dailyLossUsd) => set({ dailyLossUsd })} />
        <Num label="Cooldown per market (seconds)" value={st.cooldownSec} onChange={(cooldownSec) => set({ cooldownSec })} />
      </Section>
    </div>
  );
}
