import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  inject,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  PLATFORM_ID,
  SimpleChanges,
  ViewChild,
} from "@angular/core";
import { NgIf, isPlatformBrowser } from "@angular/common";
import * as signalR from "@microsoft/signalr";
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  LineStyle,
  BaselineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { QuotesHubConnectionService } from "./quotes-hub-connection.service";
import { type ChartTheme, getPalette } from "./chart-theme";
import {
  type Candle,
  toUtc,
  normalizeCandle,
  normalizeTfCandle,
  normalizeCandles,
  mergeCandles,
  updateLastTfCandle,
  upsertTfCandle,
  normalizeDisplayTimeframe,
  toHubTimeframe,
  timeframeToSeconds,
  normalizeSymbol,
  normalizeSource,
  parsePrice,
  stringifyError,
} from "./chart-utils";

@Component({
  selector: "app-realtime-tradingview-chart",
  standalone: true,
  imports: [NgIf],
  templateUrl: "./realtime-tradingview-chart.component.html",
  styleUrls: ["./realtime-tradingview-chart.component.scss"],
})
export class RealtimeTradingviewChartComponent
  implements AfterViewInit, OnChanges, OnDestroy
{
  @Input() theme: ChartTheme = "light";
  @Input() symbol = "";
  @Input() timeframe = "M15";
  @Input() source = "ohlc";
  @Input() active = false;
  @Input() height = 800;
  @Input() initialCandles: any[] | null = null;
  @Input() objects: any[] | null = null;
  @Input() takeProfit: string | null = null;
  @Input() stopOrder: string | null = null;
  @Input() entryPrice: string | null = null;
  @Input() hubTimeOffsetHours = 2;
  @Input() signalStatus: number | null = null;
  @Output() currentPriceChange = new EventEmitter<number>();

  @ViewChild("chartContainer", { static: false })
  chartContainerRef!: ElementRef<HTMLDivElement>;

  loading = true;
  connected = false;
  error: string | null = null;

  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser: boolean = isPlatformBrowser(this.platformId);
  private chartRef: IChartApi | null = null;
  private candlesRef: ISeriesApi<"Candlestick"> | null = null;
  private lineSeries: ISeriesApi<"Line">[] = [];
  private baselineSeries: ISeriesApi<"Baseline">[] = [];
  private connection: signalR.HubConnection | null = null;
  private candleEventHandler: ((evt: any) => void) | null = null;
  private candles: Candle[] = [];
  private seededFromChartData = false;
  private currentSymbol = "";
  private displayTimeframe = "";
  private hubTf = "";
  private tfSeconds = 60;
  private currentKey = "";
  private syncToken = 0;
  private viewInitialized = false;
  private autoFitApplied = false;
  private lastTrendlineAnchorTime: number | null = null;
  private tradeLevelPriceLines: Array<{ series: ISeriesApi<"Candlestick">; line: any }> = [];
  private tradeLevelsEndTime = 0;
  private tfSnapshotRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private seededHistoryEndTime: number | null = null;
  private lastProcessed1sTime: number | null = null;
  private removeReconnectedListener: (() => void) | null = null;
  private readonly initialTfSnapshotCount = 100;
  private readonly refreshTfSnapshotCount = 5;
  private signalStopAfterTime: number | null = null;
  private signalCrossingTime: number | null = null;
  private signalCompleted = false;
  private lastEmittedPrice: number | null = null;

  private quotesHubConnectionService = inject(QuotesHubConnectionService);

  private get hubTimeOffsetSeconds(): number {
    return Math.trunc((Number(this.hubTimeOffsetHours) || 0) * 3600);
  }

  ngAfterViewInit(): void {
    this.viewInitialized = true;
    if (!this.isBrowser) return;
    this.createChart();
    this.seedInitialCandles();
    this.renderTrendlines();
    void this.syncRealtime();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.viewInitialized || !this.isBrowser) return;
    if (changes["theme"] && this.chartRef) {
      const pal = getPalette(this.theme);
      this.chartRef.applyOptions({
        layout: { background: { type: ColorType.Solid, color: pal.background }, textColor: pal.text },
        grid: { vertLines: { color: pal.grid }, horzLines: { color: pal.grid } },
      });
    }
    if (changes["height"] && this.chartRef) this.chartRef.applyOptions({ height: this.height });
    if (changes["initialCandles"]) this.seedInitialCandles();
    if (changes["objects"]) this.renderTrendlines();
    if (changes["entryPrice"] || changes["takeProfit"] || changes["stopOrder"]) this.renderTradeLevels();
    if (changes["signalStatus"]) {
      this.onSignalStatusChange();
      this.renderCandles();
      this.renderTradeLevels();
      void this.syncRealtime();
    }
    if (changes["symbol"] || changes["timeframe"] || changes["source"] || changes["active"]) void this.syncRealtime();
  }

  ngOnDestroy(): void {
    void this.teardownRealtime();
    this.removeTrendlines();
    this.removeTradeLevels();
    this.destroyChart();
  }

  // ── Realtime lifecycle ─────────────────────────────────────────────────

  private async syncRealtime(): Promise<void> {
    const token = ++this.syncToken;
    const sym = normalizeSymbol(this.symbol);
    const tf = normalizeDisplayTimeframe(this.timeframe);
    const src = normalizeSource(this.source);

    if (!this.shouldRunRealtime() || !sym || !tf || !src) {
      await this.teardownRealtime();
      if (token !== this.syncToken) return;
      this.loading = false;
      this.connected = false;
      this.error = null;
      return;
    }

    const nextKey = `${sym}|${tf}|${src}`;
    if (this.currentKey === nextKey && this.connection && this.candleEventHandler) return;

    await this.teardownRealtime();
    if (token !== this.syncToken) return;

    this.loading = !this.seededFromChartData;
    this.error = null;

    if (!this.seededFromChartData) {
      this.candles = [];
      this.autoFitApplied = false;
      this.renderCandles();
    }

    try {
      const connection = await this.quotesHubConnectionService.ensureConnected();
      if (token !== this.syncToken) return;

      this.connection = connection;
      this.connected = connection.state === signalR.HubConnectionState.Connected;
      this.currentSymbol = sym;
      this.displayTimeframe = tf;
      this.hubTf = toHubTimeframe(tf);
      this.tfSeconds = timeframeToSeconds(tf);
      this.currentKey = nextKey;

      this.candleEventHandler = (evt: any) => this.handleCandleEvent(evt);
      connection.on("candle_event", this.candleEventHandler);

      // Reconnect handler — re-subscribe after SignalR reconnect
      this.removeReconnectedListener = this.quotesHubConnectionService.addReconnectedListener(() => {
        if (this.syncToken !== token) return;
        void this.resubscribeAfterReconnect(src);
      });

      let anySubscribed = false;

      try {
        await connection.invoke("SubscribeCandles", this.currentSymbol, this.hubTf ?? "1m", src);
        anySubscribed = true;
      } catch (tfError) {
        console.warn("TF subscribe failed, trying 1s only", tfError);
      }

      if (this.shouldUseOneSecondAggregation(src)) {
        try {
          await connection.invoke("SubscribeCandles", this.currentSymbol, "1s", src);
          anySubscribed = true;
        } catch (secError) {
          console.warn("1s subscribe failed", secError);
        }
      } else {
        await this.requestTfSnapshot(connection, src, this.initialTfSnapshotCount);
        if (token !== this.syncToken) return;
        this.startTfSnapshotRefresh(connection, src);
      }

      if (!anySubscribed && !this.seededFromChartData) {
        throw new Error("No realtime subscription succeeded");
      }
    } catch (error) {
      console.error("Failed to initialize realtime chart", error);
      if (!this.seededFromChartData) this.error = stringifyError(error);
      this.connected = false;
    } finally {
      if (token === this.syncToken) this.loading = false;
    }
  }

  private async resubscribeAfterReconnect(src: string): Promise<void> {
    const connection = this.connection;
    if (!connection || connection.state !== signalR.HubConnectionState.Connected) return;
    try {
      await connection.invoke("SubscribeCandles", this.currentSymbol, this.hubTf ?? "1m", src);
      if (this.shouldUseOneSecondAggregation(src)) {
        await connection.invoke("SubscribeCandles", this.currentSymbol, "1s", src);
      } else {
        await this.requestTfSnapshot(connection, src, this.initialTfSnapshotCount);
      }
      this.connected = true;
    } catch (error) {
      console.error("Failed to resubscribe after reconnect", error);
      this.connected = false;
    }
  }

  private handleCandleEvent(evt: any): void {
    if (!evt || evt.symbol !== this.currentSymbol) return;

    const evtSource = normalizeSource(evt.source || "");
    const expectedSource = normalizeSource(this.source);
    if (evtSource && evtSource !== expectedSource) return;

    if (evt.type === "candle" && evt.eventType === "snapshot" && evt.tf === this.hubTf) {
      const lastTime = this.candles.length ? this.candles[this.candles.length - 1].time : null;
      const snapshot = (evt.candles || [])
        .map((c: any) => normalizeTfCandle(c, this.hubTimeOffsetSeconds, this.tfSeconds, lastTime))
        .filter((c: Candle | null): c is Candle => !!c)
        .sort((a: Candle, b: Candle) => a.time - b.time);

      if (!snapshot.length) return;
      const filtered = this.filterIncomingCandlesForSeededHistory(snapshot);
      if (!filtered.length) return;
      this.candles = this.candles.length ? mergeCandles(this.candles, filtered) : filtered;
      this.renderCandles();
      return;
    }

    if (evt.type === "candle" && (evt.eventType === "candle_close" || evt.eventType === "candle_update") && evt.tf === "1s") {
      const oneSecondCandle = normalizeCandle(evt.candle, this.hubTimeOffsetSeconds);
      if (!oneSecondCandle) return;
      if (this.signalStopAfterTime !== null) {
        const bucketTime = Math.floor(oneSecondCandle.time / this.tfSeconds) * this.tfSeconds;
        if (bucketTime > this.signalStopAfterTime) return;
      }
      const result = updateLastTfCandle(this.candles, oneSecondCandle, this.tfSeconds, this.lastProcessed1sTime);
      this.candles = result.candles;
      this.lastProcessed1sTime = result.lastProcessed1sTime;
      this.renderLastCandle();
      return;
    }

    if (evt.type === "candle" && (evt.eventType === "candle_close" || evt.eventType === "candle_update") && evt.tf === this.hubTf) {
      const lastTime = this.candles.length ? this.candles[this.candles.length - 1].time : null;
      const tfCandle = normalizeTfCandle(evt.candle, this.hubTimeOffsetSeconds, this.tfSeconds, lastTime);
      if (!tfCandle || !this.shouldAcceptIncomingCandle(tfCandle)) return;
      this.candles = upsertTfCandle(this.candles, tfCandle);
      this.renderLastCandle();
    }
  }

  private async teardownRealtime(): Promise<void> {
    this.stopTfSnapshotRefresh();

    if (this.removeReconnectedListener) {
      this.removeReconnectedListener();
      this.removeReconnectedListener = null;
    }

    if (!this.connection) {
      this.candleEventHandler = null;
      this.currentKey = "";
      this.lastTrendlineAnchorTime = null;
      return;
    }

    const connection = this.connection;
    const currentSource = normalizeSource(this.source);

    if (this.candleEventHandler) {
      connection.off("candle_event", this.candleEventHandler);
      this.candleEventHandler = null;
    }

    if (this.currentSymbol && this.hubTf && currentSource && connection.state === signalR.HubConnectionState.Connected) {
      try {
        await connection.invoke("UnsubscribeCandles", this.currentSymbol, this.hubTf, currentSource);
      } catch (error) {
        console.error("Failed to unsubscribe from tf candles", error);
      }
      try {
        if (this.shouldUseOneSecondAggregation(currentSource)) {
          await connection.invoke("UnsubscribeCandles", this.currentSymbol, "1s", currentSource);
        }
      } catch (error) {
        console.error("Failed to unsubscribe from 1s candles", error);
      }
    }

    this.connection = null;
    this.currentSymbol = "";
    this.displayTimeframe = "";
    this.hubTf = "";
    this.currentKey = "";
    this.tfSeconds = 60;
    this.lastTrendlineAnchorTime = null;
    this.lastProcessed1sTime = null;
  }

  // ── Chart setup ────────────────────────────────────────────────────────

  private createChart(): void {
    if (!this.chartContainerRef?.nativeElement) return;

    const pal = getPalette(this.theme);
    const chart = createChart(this.chartContainerRef.nativeElement, {
      autoSize: true,
      height: this.height,
      rightPriceScale: { visible: true, borderVisible: false, scaleMargins: { top: 0.06, bottom: 0.06 } },
      leftPriceScale: { visible: false },
      layout: { background: { type: ColorType.Solid, color: pal.background }, textColor: pal.text },
      grid: {
        vertLines: { visible: true, color: pal.grid },
        horzLines: { visible: true, color: pal.grid },
      },
      timeScale: { rightBarStaysOnScroll: true, barSpacing: 14, rightOffset: 5, timeVisible: true, secondsVisible: false },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      lastValueVisible: true,
      priceLineVisible: false,
      priceFormat: { type: "price", precision: 5, minMove: 0.00001 },
    });

    this.chartRef = chart;
    this.candlesRef = candles;
  }

  private destroyChart(): void {
    if (!this.chartRef) return;
    this.chartRef.remove();
    this.chartRef = null;
    this.candlesRef = null;
    this.lineSeries = [];
    this.baselineSeries = [];
    this.tradeLevelPriceLines = [];
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  private renderCandles(): void {
    if (!this.chartRef || !this.candlesRef) return;
    const prevStopTime = this.signalStopAfterTime;
    if (this.signalCompleted && this.signalStopAfterTime === null) {
      this.tryComputeSignalStopTime();
    }
    if (this.signalStopAfterTime !== null && this.candles.length) {
      const trimIdx = this.candles.findIndex((c) => c.time > this.signalStopAfterTime!);
      if (trimIdx >= 0) this.candles = this.candles.slice(0, trimIdx);
    }
    // Re-render trade level rectangles when crossing is resolved (affects their end time)
    if (prevStopTime === null && this.signalStopAfterTime !== null) {
      this.renderTradeLevels();
    }

    const data = this.candles
      .map((c) => ({ time: toUtc(c.time), open: c.open, high: c.high, low: c.low, close: c.close }))
      .sort((a, b) => Number(a.time) - Number(b.time));

    this.candlesRef.setData(data);
    this.renderTrendlines();
    if (!this.signalCompleted && this.candles.length && this.candles[this.candles.length - 1].time >= this.tradeLevelsEndTime) {
      this.renderTradeLevels();
    }
    this.lastTrendlineAnchorTime = this.candles.length ? this.candles[this.candles.length - 1].time : null;
    this.emitCurrentPrice();

    if (!data.length || this.autoFitApplied) return;
    this.chartRef.timeScale().fitContent();
    this.autoFitApplied = true;
    requestAnimationFrame(() => this.chartRef?.timeScale().scrollToRealTime());
  }

  private renderLastCandle(): void {
    if (!this.candlesRef || !this.candles.length) return;

    const last = this.candles[this.candles.length - 1];
    try {
      this.candlesRef.update({ time: toUtc(last.time), open: last.open, high: last.high, low: last.low, close: last.close });
    } catch {
      const data = this.candles
        .map((c) => ({ time: toUtc(c.time), open: c.open, high: c.high, low: c.low, close: c.close }))
        .sort((a, b) => Number(a.time) - Number(b.time));
      this.candlesRef.setData(data);
    }

    if (this.lastTrendlineAnchorTime === null || this.lastTrendlineAnchorTime !== last.time) {
      this.lastTrendlineAnchorTime = last.time;
      this.renderTrendlines();
    }

    this.emitCurrentPrice();
  }

  // ── Seed / filter ──────────────────────────────────────────────────────

  private seedInitialCandles(): void {
    if (!this.initialCandles?.length || !this.candlesRef || !this.chartRef) return;
    const seeded = normalizeCandles(this.initialCandles);
    if (!seeded.length) return;
    const seedEndTime = seeded[seeded.length - 1].time;
    // Preserve candles past seed end that arrived from snapshots before seed data was set
    const postSeedCandles = this.candles.filter((c) => c.time > seedEndTime);
    this.candles = postSeedCandles.length ? mergeCandles(seeded, postSeedCandles) : seeded;
    this.seededFromChartData = true;
    this.seededHistoryEndTime = seedEndTime;
    this.signalStopAfterTime = null; // force recalculation for new candle set
    this.signalCrossingTime = null;
    this.signalCompleted = false;
    this.onSignalStatusChange();
    this.renderCandles();
  }

  private filterIncomingCandlesForSeededHistory(incoming: Candle[]): Candle[] {
    if (!this.seededFromChartData || this.seededHistoryEndTime === null) return incoming;
    return incoming.filter((c) => this.shouldAcceptIncomingCandle(c));
  }

  private shouldAcceptIncomingCandle(candle: Candle): boolean {
    if (this.seededFromChartData && this.seededHistoryEndTime !== null && candle.time <= this.seededHistoryEndTime) return false;
    if (this.signalStopAfterTime !== null && candle.time > this.signalStopAfterTime) return false;
    return true;
  }

  private shouldUseOneSecondAggregation(src: string): boolean {
    return src === "quotes";
  }

  private onSignalStatusChange(): void {
    const isCompleted = typeof this.signalStatus === "number" && this.signalStatus !== 0;
    if (!isCompleted) { this.signalCompleted = false; this.signalStopAfterTime = null; this.signalCrossingTime = null; return; }
    this.signalCompleted = true;
    this.tryComputeSignalStopTime();
  }

  private shouldRunRealtime(): boolean {
    return this.active || (this.signalCompleted && this.signalStopAfterTime === null);
  }

  /** Scan candle data to find where price crossed Target/Stop, then set signalStopAfterTime = crossing + 2 candles. */
  private tryComputeSignalStopTime(): void {
    if (this.signalStopAfterTime !== null) return; // already resolved

    const tfSec = timeframeToSeconds(normalizeDisplayTimeframe(this.timeframe));

    // No seed data — fall back to old behavior (last candle + 2)
    if (!this.seededFromChartData || this.seededHistoryEndTime === null) {
      this.tryArmSignalStopFallback(tfSec);
      return;
    }

    const entry = parsePrice(this.entryPrice);
    const target = parsePrice(this.takeProfit);
    const stop = parsePrice(this.stopOrder);

    // No levels to scan against — fall back to old behavior
    if (entry === null || (target === null && stop === null)) {
      this.tryArmSignalStopFallback(tfSec);
      return;
    }

    const isLong = target !== null ? target > entry : (stop !== null ? stop < entry : true);

    // Scan candles from seed end forward for level crossing
    for (const c of this.candles) {
      if (c.time <= this.seededHistoryEndTime) continue;

      let hit = false;
      if (target !== null) {
        if (isLong && c.high >= target) hit = true;
        if (!isLong && c.low <= target) hit = true;
      }
      if (stop !== null) {
        if (isLong && c.low <= stop) hit = true;
        if (!isLong && c.high >= stop) hit = true;
      }

      if (hit) {
        this.signalCrossingTime = c.time;
        this.signalStopAfterTime = c.time + 2 * tfSec;
        return;
      }
    }

    // Safety fallback: we have recent data but crossing not found (manual close, bid/ask spread, etc.)
    this.tryArmSignalStopFallback(tfSec);
  }

  private tryArmSignalStopFallback(tfSec: number): void {
    if (!this.candles.length) {
      return;
    }

    const lastTime = this.candles[this.candles.length - 1].time;

    // Settled charts that are already inactive will not receive post-seed
    // candles, so use the last visible candle as the terminal point.
    if (!this.active && this.signalCompleted) {
      this.signalCrossingTime = lastTime;
      this.signalStopAfterTime = lastTime;
      return;
    }

    // Do not freeze a seeded settled chart at "last seed candle + 2 bars"
    // before realtime has actually moved beyond the seed boundary.
    if (
      this.seededFromChartData &&
      this.seededHistoryEndTime !== null &&
      lastTime <= this.seededHistoryEndTime
    ) {
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (lastTime >= now - 5 * tfSec) {
      this.signalCrossingTime = lastTime;
      this.signalStopAfterTime = lastTime + 2 * tfSec;
    }
  }

  // ── Snapshot refresh with visibility check ─────────────────────────────

  private async requestTfSnapshot(connection: signalR.HubConnection, src: string, count: number): Promise<void> {
    if (!this.currentSymbol || !this.hubTf || !src || connection.state !== signalR.HubConnectionState.Connected) return;
    await connection.invoke("RequestCandlesSnapshot", this.currentSymbol, this.hubTf, src, count);
  }

  private startTfSnapshotRefresh(connection: signalR.HubConnection, src: string): void {
    this.stopTfSnapshotRefresh();
    if (!this.isBrowser || !this.currentSymbol || !this.hubTf || !src) return;
    this.tfSnapshotRefreshTimer = setInterval(() => {
      // Skip refresh when tab is hidden
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (!this.connection || this.connection !== connection || connection.state !== signalR.HubConnectionState.Connected) return;
      void this.requestTfSnapshot(connection, src, this.refreshTfSnapshotCount).catch((err: unknown) => console.warn("Failed to refresh tf snapshot", err));
    }, 5000);
  }

  private stopTfSnapshotRefresh(): void {
    if (this.tfSnapshotRefreshTimer !== null) {
      clearInterval(this.tfSnapshotRefreshTimer);
      this.tfSnapshotRefreshTimer = null;
    }
  }

  // ── Trendlines ─────────────────────────────────────────────────────────

  private removeTrendlines(): void {
    if (!this.chartRef) { this.lineSeries = []; return; }
    for (const series of this.lineSeries) {
      try { this.chartRef.removeSeries(series); } catch (e) { console.warn("Failed to remove trendline series", e); }
    }
    this.lineSeries = [];
  }

  private renderTrendlines(): void {
    if (!this.chartRef) return;
    this.removeTrendlines();

    const objects = this.objects;
    if (!objects?.length) { this.renderTradeLevels(); return; }
    if (!this.candles.length) { this.renderTradeLevels(); return; }

    const tfSec = timeframeToSeconds(normalizeDisplayTimeframe(this.timeframe));

    type BarLine = {
      style: string; rayRight: boolean; color: string; width: number;
      p1: { barIdx: number; value: number };
      p2: { barIdx: number; value: number };
      slopePerBar: number;
      intercept: number; // value at barIdx=0
      endBarIdx?: number;
      endValue?: number;
    };
    const normalizedLines: BarLine[] = [];

    for (const obj of objects) {
      if (obj?.type !== "trendline") continue;
      const rawPoints = obj?.points;
      if (!Array.isArray(rawPoints) || rawPoints.length < 2) continue;

      const points = rawPoints
        .map((p: any) => {
          const rawTime = Number(toUtc(Number(p?.time)));
          const value = Number(p?.price);
          const barIdx = this.findNearestBarIndex(rawTime, tfSec);
          return barIdx >= 0 && Number.isFinite(value) ? { barIdx, value } : null;
        })
        .filter((p): p is { barIdx: number; value: number } => p !== null)
        .sort((a, b) => a.barIdx - b.barIdx);
      if (points.length < 2) continue;

      const p1 = points[0];
      const p2 = points[points.length - 1];
      if (p1.barIdx === p2.barIdx) continue;

      const slopePerBar = (p2.value - p1.value) / (p2.barIdx - p1.barIdx);
      const intercept = p1.value - slopePerBar * p1.barIdx;

      normalizedLines.push({
        style: String(obj?.style ?? "solid").toLowerCase(),
        rayRight: !!obj?.ray_right,
        color: String(obj?.color ?? "#999999"),
        width: Number(obj?.width ?? 2),
        p1, p2, slopePerBar, intercept,
      });
    }

    // Calculate intersections in bar-index space for ray-right solid lines
    for (const l1 of normalizedLines) {
      if (!l1.rayRight || l1.style === "dot") continue;
      let earliestBarIdx = Infinity;
      let iValue: number | undefined;
      for (const l2 of normalizedLines) {
        if (l1 === l2 || !l2.rayRight || l2.style === "dot") continue;
        if (Math.abs(l1.slopePerBar - l2.slopePerBar) < 1e-12) continue;
        const xBarIdx = (l2.intercept - l1.intercept) / (l1.slopePerBar - l2.slopePerBar);
        if (xBarIdx > Math.max(l1.p1.barIdx, l2.p1.barIdx) && xBarIdx < earliestBarIdx) {
          earliestBarIdx = xBarIdx;
          iValue = l1.slopePerBar * xBarIdx + l1.intercept;
        }
      }
      if (earliestBarIdx !== Infinity && iValue !== undefined) {
        l1.endBarIdx = earliestBarIdx;
        l1.endValue = iValue;
      }
    }

    for (const line of normalizedLines) {
      const lineWidth = Math.min(Math.max(Number(line.width || 2), 1), 4) as 1 | 2 | 3 | 4;
      const series = this.chartRef.addSeries(LineSeries, {
        color: line.color, lineWidth,
        lineStyle: line.style === "dot" ? LineStyle.Dotted : LineStyle.Solid,
        priceScaleId: "right", lastValueVisible: false, priceLineVisible: false,
        pointMarkersVisible: false, autoscaleInfoProvider: () => null,
      });

      series.setData(this.buildTrendLineData(line, tfSec));
      this.lineSeries.push(series);
    }

    this.renderTradeLevels();
  }

  // ── Trade levels ───────────────────────────────────────────────────────

  private removeTradeLevels(): void {
    if (this.candlesRef) {
      for (const entry of this.tradeLevelPriceLines) {
        try { entry.series.removePriceLine(entry.line); } catch (e) { console.warn("Failed to remove trade level price line", e); }
      }
    }
    this.tradeLevelPriceLines = [];
    if (!this.chartRef) { this.baselineSeries = []; return; }
    for (const series of this.baselineSeries) {
      try { this.chartRef.removeSeries(series); } catch (e) { console.warn("Failed to remove trade level series", e); }
    }
    this.baselineSeries = [];
  }

  private renderTradeLevels(): void {
    if (!this.chartRef || !this.candlesRef) return;
    this.removeTradeLevels();

    const entry = parsePrice(this.entryPrice);
    const target = parsePrice(this.takeProfit);
    const stop = parsePrice(this.stopOrder);
    if (entry === null && target === null && stop === null) return;

    const tfSec = timeframeToSeconds(normalizeDisplayTimeframe(this.timeframe));
    const { startX, endX } = this.getTradeLevelsRange(tfSec);
    this.tradeLevelsEndTime = endX;

    if (entry !== null && target !== null) {
      const isLong = target > entry;
      const tpSeries = this.chartRef.addSeries(BaselineSeries, {
        baseValue: { type: "price", price: entry },
        topFillColor1: isLong ? "rgba(76, 175, 80, 0.2)" : "rgba(0, 0, 0, 0)",
        topFillColor2: isLong ? "rgba(76, 175, 80, 0.2)" : "rgba(0, 0, 0, 0)",
        topLineColor: isLong ? "rgba(76, 175, 80, 1)" : "rgba(0, 0, 0, 0)",
        bottomFillColor1: !isLong ? "rgba(76, 175, 80, 0.2)" : "rgba(0, 0, 0, 0)",
        bottomFillColor2: !isLong ? "rgba(76, 175, 80, 0.2)" : "rgba(0, 0, 0, 0)",
        bottomLineColor: !isLong ? "rgba(76, 175, 80, 1)" : "rgba(0, 0, 0, 0)",
        lineWidth: 1, lineStyle: LineStyle.Solid, priceScaleId: "right",
        lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false,
        baseLineVisible: false, autoscaleInfoProvider: () => null,
      });
      tpSeries.setData(this.buildBaselineData(startX, endX, target, tfSec));
      this.baselineSeries.push(tpSeries);
    }

    if (entry !== null && stop !== null) {
      const isLong = stop < entry;
      const slSeries = this.chartRef.addSeries(BaselineSeries, {
        baseValue: { type: "price", price: entry },
        topFillColor1: !isLong ? "rgba(239, 83, 80, 0.2)" : "rgba(0, 0, 0, 0)",
        topFillColor2: !isLong ? "rgba(239, 83, 80, 0.2)" : "rgba(0, 0, 0, 0)",
        topLineColor: !isLong ? "rgba(239, 83, 80, 1)" : "rgba(0, 0, 0, 0)",
        bottomFillColor1: isLong ? "rgba(239, 83, 80, 0.2)" : "rgba(0, 0, 0, 0)",
        bottomFillColor2: isLong ? "rgba(239, 83, 80, 0.2)" : "rgba(0, 0, 0, 0)",
        bottomLineColor: isLong ? "rgba(239, 83, 80, 1)" : "rgba(0, 0, 0, 0)",
        lineWidth: 1, lineStyle: LineStyle.Solid, priceScaleId: "right",
        lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false,
        baseLineVisible: false, autoscaleInfoProvider: () => null,
      });
      slSeries.setData(this.buildBaselineData(startX, endX, stop, tfSec));
      this.baselineSeries.push(slSeries);
    }

    if (entry !== null) {
      const line = this.candlesRef.createPriceLine({ price: entry, color: "#8b9098", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "Entry", lineVisible: true });
      this.tradeLevelPriceLines.push({ series: this.candlesRef, line });
    }
    if (stop !== null) {
      const line = this.candlesRef.createPriceLine({ price: stop, color: "#ef5350", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "Stop", lineVisible: true });
      this.tradeLevelPriceLines.push({ series: this.candlesRef, line });
    }
    if (target !== null) {
      const line = this.candlesRef.createPriceLine({ price: target, color: "#18a67d", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "Target", lineVisible: true });
      this.tradeLevelPriceLines.push({ series: this.candlesRef, line });
    }
  }

  private getTradeLevelsRange(tfSec: number): { startX: number; endX: number } {
    let startX = Math.floor(Date.now() / 1000);
    const lastInitialCandle = this.initialCandles?.length ? this.initialCandles[this.initialCandles.length - 1] : null;
    const lastLiveCandle = this.candles.length ? this.candles[this.candles.length - 1] : null;
    if (lastInitialCandle) startX = Number(toUtc(lastInitialCandle.time));
    else if (lastLiveCandle) startX = lastLiveCandle.time;

    // For settled signals with a known crossing, end the rectangles at the crossing candle
    if (this.signalCompleted && this.signalCrossingTime !== null) {
      return { startX, endX: this.signalCrossingTime };
    }

    // For active (online) signals — extend rectangles to the right edge and beyond
    const lastCandleTime = this.candles.length ? this.candles[this.candles.length - 1].time : startX;
    const visibleRange = this.chartRef?.timeScale().getVisibleRange();
    const visibleEnd = visibleRange ? Number(visibleRange.to) : 0;
    let endX = Math.max(lastCandleTime + tfSec * 30, visibleEnd + tfSec * 5);

    const objects = Array.isArray(this.objects) ? this.objects : [];
    for (const object of objects) {
      if (object?.type !== "trendline" || String(object?.style ?? "").toLowerCase() !== "dot") continue;
      const rawPoints = Array.isArray(object?.points) ? object.points : [];
      for (const point of rawPoints) {
        const pointTime = Number(toUtc(Number(point?.time)));
        if (Number.isFinite(pointTime) && pointTime > endX) endX = pointTime;
      }
    }
    return { startX, endX };
  }

  // ── Bar-index helpers ──────────────────────────────────────────────────

  /**
   * Find the index of the candle nearest to `rawTime` (within one tfSec).
   * Returns -1 if no candle is close enough.
   *
   * lightweight-charts uses a categorical time axis (equal bar width),
   * so trendline math must operate on bar indices, not timestamps.
   */
  private findNearestBarIndex(rawTime: number, tfSec: number): number {
    if (!this.candles.length) return -1;
    let nearestIdx = 0;
    let nearestDist = Math.abs(this.candles[0].time - rawTime);
    for (let i = 1; i < this.candles.length; i++) {
      const d = Math.abs(this.candles[i].time - rawTime);
      if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
    }
    return nearestDist <= tfSec ? nearestIdx : -1;
  }

  // ── Line data builders ─────────────────────────────────────────────────

  /**
   * Build LineSeries data for a trendline using bar-index-based interpolation.
   * Every data point is placed at an existing candle time (or tfSec-spaced
   * beyond the last candle), so no extra time-axis slots are created.
   */
  private buildTrendLineData(
    line: {
      p1: { barIdx: number; value: number }; p2: { barIdx: number; value: number };
      slopePerBar: number; rayRight: boolean; endBarIdx?: number; endValue?: number;
    },
    tfSec: number,
  ): Array<{ time: UTCTimestamp; value: number }> {
    const data: Array<{ time: UTCTimestamp; value: number }> = [];
    const n = this.candles.length;

    // Determine the last integer bar index to emit
    let lastIntBar: number;
    if (!line.rayRight) {
      lastIntBar = line.p2.barIdx;
    } else if (line.endBarIdx !== undefined) {
      lastIntBar = Math.floor(line.endBarIdx);
    } else {
      lastIntBar = line.p2.barIdx + 15;
    }

    // Emit a point at every bar from p1 to lastIntBar
    for (let i = line.p1.barIdx; i <= lastIntBar; i++) {
      const value = line.p1.value + line.slopePerBar * (i - line.p1.barIdx);
      if (i < n) {
        data.push({ time: this.candles[i].time as UTCTimestamp, value });
      } else {
        // Beyond existing candles — extrapolate time
        const t = this.candles[n - 1].time + (i - n + 1) * tfSec;
        data.push({ time: Math.round(t) as UTCTimestamp, value });
      }
    }

    return data;
  }

  private buildBaselineData(startX: number, endX: number, val: number, tfSec: number): Array<{ time: UTCTimestamp; value: number }> {
    if (endX <= startX) return [{ time: Math.round(startX) as UTCTimestamp, value: val }];

    const points: Array<{ time: UTCTimestamp; value: number }> = [];
    const startRounded = Math.round(startX);
    points.push({ time: startRounded as UTCTimestamp, value: val });
    let lastTime = startRounded;

    // Use real candle times for intermediate points
    for (const c of this.candles) {
      if (c.time > startX && c.time < endX && c.time !== lastTime) {
        points.push({ time: c.time as UTCTimestamp, value: val });
        lastTime = c.time;
      }
    }

    // Extend beyond last candle if needed
    const lastCandleTime = this.candles.length ? this.candles[this.candles.length - 1].time : startX;
    if (endX > lastCandleTime) {
      let t = lastCandleTime + tfSec;
      while (t < endX) {
        const rounded = Math.round(t);
        if (t > startX && rounded !== lastTime) {
          points.push({ time: rounded as UTCTimestamp, value: val });
          lastTime = rounded;
        }
        t += tfSec;
      }
    }

    const endRounded = Math.round(endX);
    if (endRounded !== lastTime) {
      points.push({ time: endRounded as UTCTimestamp, value: val });
    }

    return points;
  }

  private emitCurrentPrice(): void {
    const nextPrice = Number(this.candles[this.candles.length - 1]?.close);
    if (!Number.isFinite(nextPrice)) {
      return;
    }

    const roundedPrice = Math.round(nextPrice * 100000) / 100000;
    if (this.lastEmittedPrice === roundedPrice) {
      return;
    }

    this.lastEmittedPrice = roundedPrice;
    this.currentPriceChange.emit(roundedPrice);
  }
}
