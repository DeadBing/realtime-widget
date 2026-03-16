import type { UTCTimestamp } from "lightweight-charts";

// ── Types ──────────────────────────────────────────────────────────────────

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

// ── Timestamp helpers ──────────────────────────────────────────────────────

export function toUtc(timestamp: number | string): UTCTimestamp {
  const value = typeof timestamp === "string" ? Number(timestamp) : timestamp;
  const seconds = value > 1e12 ? Math.floor(value / 1000) : Math.floor(value || 0);
  return seconds as UTCTimestamp;
}

// ── Candle normalization ───────────────────────────────────────────────────

export function readNumber(source: any, keys: string[]): number | null {
  for (const key of keys) {
    const value = source?.[key];
    if (value === null || value === undefined || value === "") continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

export function readOptionalNumber(source: any, keys: string[]): number | undefined {
  const value = readNumber(source, keys);
  return value === null ? undefined : value;
}

export function normalizeCandle(candle: any, timeOffsetSeconds = 0): Candle | null {
  if (!candle) return null;
  const time = readNumber(candle, ["time", "Time", "t", "T"]);
  const open = readNumber(candle, ["open", "Open", "o", "O"]);
  const high = readNumber(candle, ["high", "High", "h", "H"]);
  const low = readNumber(candle, ["low", "Low", "l", "L"]);
  const close = readNumber(candle, ["close", "Close", "c", "C"]);
  const volume = readOptionalNumber(candle, ["volume", "Volume", "v", "V"]);
  if (time === null || open === null || high === null || low === null || close === null) return null;
  return { time: Number(toUtc(time)) + timeOffsetSeconds, open, high, low, close, volume };
}

export function normalizeTfCandle(candle: any, timeOffsetSeconds: number, timeframeSeconds: number, lastCandleTime: number | null): Candle | null {
  const normalized = normalizeCandle(candle, timeOffsetSeconds);
  if (!normalized) return null;
  return { ...normalized, time: normalizeTfTimestamp(normalized.time, timeframeSeconds, lastCandleTime) };
}

export function normalizeTfTimestamp(rawTime: number, timeframeSeconds: number, lastCandleTime: number | null): number {
  const raw = Number(toUtc(rawTime));
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const tfSec = Math.max(1, timeframeSeconds || 60);
  return Math.floor(raw / tfSec) * tfSec;
}

export function normalizeCandles(rawCandles: any[] | null, timeOffsetSeconds = 0): Candle[] {
  return (Array.isArray(rawCandles) ? rawCandles : [])
    .map((c) => normalizeCandle(c, timeOffsetSeconds))
    .filter((c: Candle | null): c is Candle => !!c)
    .sort((a, b) => a.time - b.time);
}

// ── Candle merge / update ──────────────────────────────────────────────────

export function mergeCandles(previous: Candle[], incoming: Candle[]): Candle[] {
  if (!previous.length) return [...incoming].sort((a, b) => a.time - b.time);
  const byTime = new Map<number, Candle>();
  for (const c of previous) byTime.set(c.time, c);
  for (const c of incoming) byTime.set(c.time, c);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

/**
 * Aggregate a 1-second candle into the current timeframe bucket.
 * Mutates the last element in-place when updating the same bucket (avoids spread/copy).
 * `lastProcessed1sTime` prevents double-counting volume on `candle_update` for the same 1s candle.
 */
export function updateLastTfCandle(
  previous: Candle[],
  oneSecondCandle: Candle,
  timeframeSeconds: number,
  lastProcessed1sTime: number | null,
): { candles: Candle[]; lastProcessed1sTime: number } {
  const bucketStart = Math.floor(oneSecondCandle.time / timeframeSeconds) * timeframeSeconds;
  const isDuplicate1s = lastProcessed1sTime !== null && oneSecondCandle.time === lastProcessed1sTime;

  if (!previous.length) {
    return {
      candles: [{
        time: bucketStart,
        open: oneSecondCandle.open,
        high: oneSecondCandle.high,
        low: oneSecondCandle.low,
        close: oneSecondCandle.close,
        volume: oneSecondCandle.volume || 0,
      }],
      lastProcessed1sTime: oneSecondCandle.time,
    };
  }

  const last = previous[previous.length - 1];

  if (last.time === bucketStart) {
    // Update in-place — no array copy
    last.high = Math.max(last.high, oneSecondCandle.high);
    last.low = Math.min(last.low, oneSecondCandle.low);
    last.close = oneSecondCandle.close;
    if (!isDuplicate1s) {
      last.volume = (last.volume || 0) + (oneSecondCandle.volume || 0);
    }
    return { candles: previous, lastProcessed1sTime: oneSecondCandle.time };
  }

  if (bucketStart > last.time) {
    previous.push({
      time: bucketStart,
      open: oneSecondCandle.open,
      high: oneSecondCandle.high,
      low: oneSecondCandle.low,
      close: oneSecondCandle.close,
      volume: oneSecondCandle.volume || 0,
    });
    return { candles: previous, lastProcessed1sTime: oneSecondCandle.time };
  }

  return { candles: previous, lastProcessed1sTime: oneSecondCandle.time };
}

/**
 * Insert or update a timeframe candle. Searches from the end for efficiency.
 */
export function upsertTfCandle(previous: Candle[], nextCandle: Candle): Candle[] {
  if (!previous.length) return [nextCandle];

  // Search from end — the target candle is almost always the last or second-to-last
  for (let i = previous.length - 1; i >= 0 && i >= previous.length - 3; i--) {
    if (previous[i].time === nextCandle.time) {
      previous[i] = nextCandle;
      return previous;
    }
  }

  const last = previous[previous.length - 1];
  if (nextCandle.time > last.time) {
    previous.push(nextCandle);
    return previous;
  }

  return previous;
}

// ── Timeframe helpers ──────────────────────────────────────────────────────

export function normalizeDisplayTimeframe(value: string): string {
  if (!value) return "";
  const prepared = value.trim().replace(/\u041c/g, "M").replace(/\u043c/g, "m");
  if (!prepared) return "";
  if (/^\d+$/.test(prepared)) return `M${prepared}`;
  const upper = prepared.toUpperCase();
  if (upper === "MN") return "MN1";
  if (/^M\d+$/.test(upper)) {
    const mins = Number(upper.replace("M", ""));
    if (mins === 60) return "H1";
    if (mins === 240) return "H4";
    if (mins === 1440) return "D1";
    if (mins === 10080) return "W1";
    if (mins === 43200) return "MN1";
    return upper;
  }
  if (/^H\d+$/.test(upper)) return upper;
  if (upper === "D1" || upper === "W1" || upper === "MN1" || upper === "Y1") return upper;
  if (/^\d+M$/.test(upper)) return `M${upper.slice(0, -1)}`;
  if (/^\d+H$/.test(upper)) return `H${upper.slice(0, -1)}`;
  if (upper === "1D") return "D1";
  if (upper === "1W") return "W1";
  if (upper === "1Y") return "Y1";
  return "";
}

export function toHubTimeframe(displayTimeframe: string): string {
  const map: Record<string, string> = {
    M1: "1m", M5: "5m", M15: "15m", M30: "30m", M60: "1h", M240: "4h",
    M1440: "1d", M10080: "1w", M43200: "1M",
    H1: "1h", H4: "4h", D1: "1d", W1: "1w", MN1: "1M", Y1: "1y",
  };
  return map[displayTimeframe] || displayTimeframe;
}

export function timeframeToSeconds(displayTimeframe: string): number {
  const value = displayTimeframe.toUpperCase().trim();
  if (value === "MN1") return 30 * 86400;
  if (value === "W1") return 7 * 86400;
  if (value === "Y1") return 365 * 86400;
  if (value.startsWith("M")) return Number(value.replace("M", "")) * 60;
  if (value.startsWith("H")) return Number(value.replace("H", "")) * 3600;
  if (value.startsWith("D")) return Number(value.replace("D", "")) * 86400;
  return 60;
}

// ── Source / symbol ────────────────────────────────────────────────────────

export function normalizeSymbol(value: string): string {
  return (value || "").trim().toUpperCase();
}

export function normalizeSource(value: string): string {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "ohlc" || normalized === "quotes" ? normalized : "";
}

// ── Price precision ────────────────────────────────────────────────────────

export function inferPrecision(values: number[]): number {
  let precision = 2;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    const text = value.toString().toLowerCase();
    if (text.includes("e-")) {
      precision = Math.max(precision, Number(text.split("e-")[1] || 0));
      continue;
    }
    const index = text.indexOf(".");
    if (index >= 0) precision = Math.max(precision, text.length - index - 1);
  }
  return Math.min(Math.max(precision, 2), 10);
}

// ── Misc ───────────────────────────────────────────────────────────────────

export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parsePrice(value: string | null): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
