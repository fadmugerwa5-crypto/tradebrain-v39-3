import type { Tick } from "./bounce.ts";

const PUBLIC_WS = "wss://api.derivws.com/trading/v1/options/ws/public";
const MAX_TICKS = 4000;

/** Public Deriv tick feed for many markets at once. Read-only: it never places orders. */
export class TickHub {
  private ws: WebSocket | null = null;
  private buffers = new Map<string, Tick[]>();
  private wanted: string[] = [];
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  connected = false;
  lastMessageAt = 0;

  get(symbol: string): Tick[] {
    return this.buffers.get(symbol) ?? [];
  }

  last(symbol: string): Tick | undefined {
    const b = this.buffers.get(symbol);
    return b?.[b.length - 1];
  }

  /** Puts earlier ticks in front of whatever has already arrived live. */
  seed(symbol: string, history: Tick[]) {
    const live = this.buffers.get(symbol) ?? [];
    const firstLive = live[0]?.at ?? Infinity;
    const merged = [...history.filter((t) => t.at < firstLive), ...live];
    this.buffers.set(symbol, merged.slice(-MAX_TICKS));
  }

  start(symbols: string[]) {
    this.stopped = false;
    this.wanted = [...new Set(symbols.filter(Boolean))];
    this.open();
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
    this.connected = false;
  }

  private open() {
    if (typeof WebSocket === "undefined" || this.ws) return;
    const ws = new WebSocket(PUBLIC_WS);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.wanted.forEach((symbol, i) => setTimeout(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 })), i * 25));
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      try {
        const q = JSON.parse(String(ev.data))?.tick;
        if (!q?.symbol || !(Number(q.quote) > 0)) return;
        const rows = this.buffers.get(String(q.symbol)) ?? [];
        rows.push({ at: Number(q.epoch) * 1000, price: Number(q.quote) });
        if (rows.length > MAX_TICKS) rows.splice(0, rows.length - MAX_TICKS);
        this.buffers.set(String(q.symbol), rows);
      } catch {
        /* ignore a malformed message */
      }
    };
    ws.onerror = () => {
      /* onclose follows and schedules the reconnect */
    };
    ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      if (this.stopped || this.retry) return;
      this.retry = setTimeout(() => {
        this.retry = null;
        if (!this.stopped) this.open();
      }, 2500);
    };
  }
}

export const hub = new TickHub();
