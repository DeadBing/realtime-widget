import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  PLATFORM_ID,
  SimpleChanges,
  ViewChild,
  inject,
} from "@angular/core";
import { NgIf, isPlatformBrowser } from "@angular/common";
import * as signalR from "@microsoft/signalr";
import {
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  calculateMacdSeries,
  calculateRsiSeries,
  calculateStochasticSeries,
} from "./divergence-indicators";
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
  inferPrecision,
  parsePrice,
  stringifyError,
  buildFocusedLogicalRange,
  buildTrailingLogicalRange,
  getLogicalRangeSpan,
} from "./chart-utils";

type AnySeries =
  | ISeriesApi<"Candlestick">
  | ISeriesApi<"Line">
  | ISeriesApi<"Histogram">
  | ISeriesApi<"Baseline">;
type TrendLine = {
  color: string;
  width: 1 | 2 | 3 | 4;
  style: "solid" | "dot";
  rayRight: boolean;
  paneIndex: number;
  p1: { barIdx: number; value: number };
  p2: { barIdx: number; value: number };
  slopePerBar: number;
  intercept: number;
  endBarIdx?: number;
  endValue?: number;
};
type DivergenceIndicator = "stochastic" | "rsi" | "macd";
type DivergenceAnnotationCache = {
  key: string;
  trendLines: any[] | null;
  objects: any[] | null;
};

@Component({
  selector: "app-realtime-divergence-chart",
  standalone: true,
  imports: [NgIf],
  templateUrl: "./realtime-divergence-chart.component.html",
  styleUrls: ["./realtime-divergence-chart.component.scss"],
})
export class RealtimeDivergenceChartComponent
  implements AfterViewInit, OnChanges, OnDestroy
{
  @Input() theme: ChartTheme = "light";
  @Input() symbol = "";
  @Input() timeframe = "M15";
  @Input() source = "ohlc";
  @Input() active = false;
  @Input() previewOnly = false;
  @Input() activeIndicator: DivergenceIndicator | null = null;
  @Input() height = 800;
  @Input() initialCandles: any[] | null = null;
  @Input() trendLines: any[] | null = null;
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
  private readonly isBrowser = isPlatformBrowser(this.platformId);
  private readonly hub = inject(QuotesHubConnectionService);

  private chartRef: IChartApi | null = null;
  private priceSeries: ISeriesApi<"Candlestick"> | null = null;
  private stochasticKSeries: ISeriesApi<"Line"> | null = null;
  private stochasticDSeries: ISeriesApi<"Line"> | null = null;
  private rsiSeries: ISeriesApi<"Line"> | null = null;
  private macdHistogramSeries: ISeriesApi<"Histogram"> | null = null;
  private macdSignalSeries: ISeriesApi<"Line"> | null = null;
  private macdLineSeries: ISeriesApi<"Line"> | null = null;
  private overlayLineSeries: ISeriesApi<"Line">[] = [];
  private tradeLevelAreaSeries: ISeriesApi<"Baseline">[] = [];
  private priceLines: Array<{ series: AnySeries; line: unknown }> = [];
  private guideLines: Array<{ series: AnySeries; line: unknown }> = [];
  private connection: signalR.HubConnection | null = null;
  private candleEventHandler: ((evt: any) => void) | null = null;
  private visibleLogicalRangeHandler: ((range: LogicalRange | null) => void) | null = null;
  private tfSnapshotRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private removeReconnectedListener: (() => void) | null = null;
  private candles: Candle[] = [];
  private articleSeedCandles: Candle[] = [];
  private indicatorWarmupCandles: Candle[] = [];
  private seededFromChartData = false;
  private seededHistoryStartTime: number | null = null;
  private seededHistoryEndTime: number | null = null;
  private viewInitialized = false;
  private autoFitApplied = false;
  private pricePrecisionApplied = false;
  private tradeLevelsRendered = false;
  private tradeLevelsEndTime = 0;
  private currentSymbol = "";
  private currentSource = "";
  private hubTf = "";
  private tfSeconds = 300;
  private currentKey = "";
  private syncToken = 0;
  private lastProcessed1sTime: number | null = null;
  private signalStopAfterTime: number | null = null;
  private signalCrossingTime: number | null = null;
  private signalCompleted = false;
  private readonly initialTfSnapshotCount = 300;
  private readonly refreshTfSnapshotCount = 5;
  private readonly indicatorWarmupLimit = 300;
  private lastEmittedPrice: number | null = null;
  private readonly defaultRightOffsetBars = 3;
  private readonly realtimeFollowThresholdBars = 1.5;
  private annotationCache: DivergenceAnnotationCache | null = null;
  private usedCachedAnnotationsForLastRender = false;
  private readonly trendlineDebugEnabled =
    this.isBrowser &&
    typeof window !== "undefined" &&
    /^(localhost|127(?:\.\d{1,3}){3})$/i.test(window.location.hostname);
  private get tradingViewPalette() {
    return getPalette(this.theme);
  }
  private get resolvedActiveIndicator(): DivergenceIndicator | null {
    return this.normalizeActiveIndicator(this.activeIndicator)
      ?? this.inferActiveIndicatorFromPayload();
  }
  private get usesSingleIndicatorLayout(): boolean {
    return this.resolvedActiveIndicator !== null;
  }
  private followRealtime = true;
  private suppressVisibleRangeTracking = false;

  private get hubTimeOffsetSeconds(): number {
    return Math.trunc((Number(this.hubTimeOffsetHours) || 0) * 3600);
  }

  ngAfterViewInit(): void {
    this.viewInitialized = true;
    if (!this.isBrowser) return;
    this.createChart();
    this.seedInitialCandles();
    this.renderTrendlines();
    this.renderTradeLevels();
    void this.syncRealtime();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.viewInitialized || !this.isBrowser) return;
    if (changes["activeIndicator"] && !changes["activeIndicator"].firstChange) {
      this.recreateChart();
      return;
    }
    if (changes["theme"] && this.chartRef) {
      const pal = this.tradingViewPalette;
      this.chartRef.applyOptions({
        layout: { background: { type: ColorType.Solid, color: pal.background }, textColor: pal.text },
        grid: { vertLines: { color: pal.grid }, horzLines: { color: pal.grid } },
      });
    }
    if (changes["height"] && this.chartRef) this.chartRef.applyOptions({ height: this.height });
    if (changes["initialCandles"]) this.seedInitialCandles();
    if (
      changes["trendLines"] ||
      changes["objects"] ||
      changes["timeframe"] ||
      changes["symbol"] ||
      changes["initialCandles"]
    ) {
      this.renderTrendlines();
    }
    if (changes["entryPrice"] || changes["takeProfit"] || changes["stopOrder"] || changes["timeframe"] || changes["initialCandles"]) {
      this.tradeLevelsRendered = false;
      this.renderTradeLevels();
    }
    if (changes["signalStatus"]) {
      this.onSignalStatusChange();
      this.tradeLevelsRendered = false;
      this.renderMarketDataFull();
      this.renderTrendlines();
    }
    if (changes["symbol"] || changes["timeframe"] || changes["source"] || changes["active"] || changes["previewOnly"] || changes["hubTimeOffsetHours"]) void this.syncRealtime();
  }

  ngOnDestroy(): void {
    void this.teardownRealtime();
    this.removeTrendlines();
    this.removeTradeLevels();
    this.removeGuideLines();
    this.destroyChart();
  }

  // ── Chart setup ────────────────────────────────────────────────────────

  private createChart(): void {
    if (!this.chartContainerRef?.nativeElement) return;
    const pal = this.tradingViewPalette;
    const paneCount = this.usesSingleIndicatorLayout ? 2 : 4;
    const chart = createChart(this.chartContainerRef.nativeElement, {
      autoSize: true,
      height: this.height,
      layout: { background: { type: ColorType.Solid, color: pal.background }, textColor: pal.text },
      localization: {
        locale: "en-US",
        dateFormat: "dd.MM.yyyy",
        timeFormatter: (time: unknown) => this.formatHoverDate(time),
      },
      grid: {
        vertLines: { visible: true, color: pal.grid },
        horzLines: { visible: true, color: pal.grid },
      },
      rightPriceScale: { visible: true, borderVisible: false, scaleMargins: { top: 0.06, bottom: 0.06 } },
      leftPriceScale: { visible: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true } },
      handleScroll: { mouseWheel: false, pressedMouseMove: false, horzTouchDrag: true, vertTouchDrag: false },
      timeScale: { rightBarStaysOnScroll: true, barSpacing: 10, rightOffset: this.defaultRightOffsetBars, borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { width: 1, color: pal.crosshair }, horzLine: { width: 1, color: pal.crosshair } },
    });

    while (chart.panes().length < paneCount) chart.addPane(true);
    chart.panes()[0]?.setStretchFactor(9);
    chart.panes()[1]?.setStretchFactor(3);
    if (!this.usesSingleIndicatorLayout) {
      chart.panes()[2]?.setStretchFactor(2);
      chart.panes()[3]?.setStretchFactor(2);
    }

    const oscaleProvider = () => ({ priceRange: { minValue: 0, maxValue: 100 } });
    this.priceSeries = chart.addSeries(CandlestickSeries, {
      upColor: pal.up, downColor: pal.down, borderUpColor: pal.up, borderDownColor: pal.down,
      wickUpColor: pal.up, wickDownColor: pal.down, lastValueVisible: true, priceLineVisible: false,
    }, 0);
    if (!this.usesSingleIndicatorLayout || this.resolvedActiveIndicator === "stochastic") {
      const stochasticPaneIndex = this.getIndicatorPaneIndex("stochastic");
      this.stochasticKSeries = chart.addSeries(LineSeries, { color: pal.blue, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false, autoscaleInfoProvider: oscaleProvider }, stochasticPaneIndex);
      this.stochasticDSeries = chart.addSeries(LineSeries, { color: pal.orange, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false, autoscaleInfoProvider: oscaleProvider }, stochasticPaneIndex);
      chart.priceScale("right", stochasticPaneIndex).applyOptions({ autoScale: false, scaleMargins: { top: 0.08, bottom: 0.08 } });
    }
    if (!this.usesSingleIndicatorLayout || this.resolvedActiveIndicator === "rsi") {
      const rsiPaneIndex = this.getIndicatorPaneIndex("rsi");
      this.rsiSeries = chart.addSeries(LineSeries, { color: pal.blue, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false, autoscaleInfoProvider: oscaleProvider }, rsiPaneIndex);
      chart.priceScale("right", rsiPaneIndex).applyOptions({ autoScale: false, scaleMargins: { top: 0.08, bottom: 0.08 } });
    }
    if (!this.usesSingleIndicatorLayout || this.resolvedActiveIndicator === "macd") {
      const macdPaneIndex = this.getIndicatorPaneIndex("macd");
      this.macdHistogramSeries = chart.addSeries(HistogramSeries, { base: 0, color: pal.macdPositive, lastValueVisible: false, priceLineVisible: false }, macdPaneIndex);
      this.macdSignalSeries = chart.addSeries(LineSeries, { color: pal.orange, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false }, macdPaneIndex);
      this.macdLineSeries = chart.addSeries(LineSeries, { color: pal.macdMain, lineWidth: 2, lineStyle: LineStyle.Dotted, lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false }, macdPaneIndex);
      chart.priceScale("right", macdPaneIndex).applyOptions({ autoScale: true, scaleMargins: { top: 0.12, bottom: 0.12 } });
    }

    this.chartRef = chart;
    this.visibleLogicalRangeHandler = (range: LogicalRange | null) => this.handleVisibleLogicalRangeChange(range);
    chart.timeScale().subscribeVisibleLogicalRangeChange(this.visibleLogicalRangeHandler);
    this.createGuideLines();
  }

  private recreateChart(): void {
    this.removeTrendlines();
    this.removeTradeLevels();
    this.removeGuideLines();
    this.destroyChart();
    this.autoFitApplied = false;
    this.createChart();
    this.renderMarketDataFull();
    this.renderTrendlines();
    this.renderTradeLevels();
  }

  // ── Seed ───────────────────────────────────────────────────────────────

  private seedInitialCandles(): void {
    this.articleSeedCandles = normalizeCandles(this.initialCandles);
    this.indicatorWarmupCandles = [];
    this.pricePrecisionApplied = false;
    this.tradeLevelsRendered = false;
    this.seededFromChartData = this.articleSeedCandles.length > 0;
    this.seededHistoryStartTime = this.seededFromChartData ? this.articleSeedCandles[0].time : null;
    this.seededHistoryEndTime = this.seededFromChartData ? this.articleSeedCandles[this.articleSeedCandles.length - 1].time : null;
    this.signalStopAfterTime = null;
    this.signalCrossingTime = null;
    this.signalCompleted = false;
    if (this.seededFromChartData) {
      // Preserve candles outside seed range that arrived from snapshots before seed data was set
      const extraCandles = this.candles.filter((c) => c.time < this.seededHistoryStartTime! || c.time > this.seededHistoryEndTime!);
      this.candles = extraCandles.length ? mergeCandles([...this.articleSeedCandles], extraCandles) : [...this.articleSeedCandles];
      this.error = null;
      this.autoFitApplied = false;
      this.followRealtime = true;
      this.onSignalStatusChange();
      this.renderMarketDataFull();
    } else if (!this.shouldRunRealtime()) {
      this.candles = [];
      this.onSignalStatusChange();
      this.renderMarketDataFull();
    } else {
      this.onSignalStatusChange();
    }
  }

  private onSignalStatusChange(): void {
    const isCompleted = typeof this.signalStatus === "number" && this.signalStatus !== 0;
    if (!isCompleted) { this.signalCompleted = false; this.signalStopAfterTime = null; this.signalCrossingTime = null; return; }
    this.signalCompleted = true;
    this.tryComputeSignalStopTime();
  }

  private shouldRunRealtime(): boolean {
    if (this.previewOnly) {
      return false;
    }

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

    // When chartData is seeded from the article, do not freeze the chart at
    // "last seed candle + 2 bars" before realtime candles have actually moved
    // past the seed boundary. Otherwise completed divergence articles stop
    // accepting live candles and end up truncated in an article-specific way.
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

  // ── Realtime lifecycle ─────────────────────────────────────────────────

  private async syncRealtime(): Promise<void> {
    const token = ++this.syncToken;
    const sym = normalizeSymbol(this.symbol);
    const tf = normalizeDisplayTimeframe(this.timeframe);
    const src = normalizeSource(this.source);
    if (this.previewOnly) {
      await this.teardownRealtime();
      if (token !== this.syncToken) return;

      if (!sym || !tf || !src) {
        this.loading = false;
        this.connected = false;
        this.error = null;
        this.renderMarketDataFull();
        return;
      }

      this.loading = !this.candles.length;
      this.error = null;
      this.currentSymbol = sym;
      this.currentSource = src;
      this.hubTf = toHubTimeframe(tf);
      this.tfSeconds = timeframeToSeconds(tf);
      this.currentKey = `${sym}|${tf}|${src}|${this.hubTimeOffsetSeconds}|preview`;

      try {
        const connection = await this.hub.ensureConnected();
        if (token !== this.syncToken) return;

        this.connection = connection;
        this.candleEventHandler = (evt: any) => this.handleCandleEvent(evt);
        connection.on("candle_event", this.candleEventHandler);

        // Single snapshot request — no SubscribeCandles, no refresh timer
        await this.requestTfSnapshot(connection, src, this.initialTfSnapshotCount);
      } catch (error) {
        console.warn("Divergence preview snapshot fetch failed", error);
      } finally {
        if (token === this.syncToken) {
          this.loading = false;
          this.connected = false;
          this.renderMarketDataFull();
        }
      }
      return;
    }

    if (!this.shouldRunRealtime() || !sym || !tf || !src) {
      await this.teardownRealtime();
      if (token !== this.syncToken) return;
      this.loading = false;
      this.connected = false;
      if (!this.candles.length && !this.seededFromChartData) this.error = "No candle data provided for divergence chart.";
      return;
    }
    const nextKey = `${sym}|${tf}|${src}|${this.hubTimeOffsetSeconds}`;
    if (this.currentKey === nextKey && this.connection && this.candleEventHandler) return;
    await this.teardownRealtime();
    if (token !== this.syncToken) return;
    this.loading = !this.candles.length;
    this.error = null;
    this.currentSymbol = sym;
    this.currentSource = src;
    this.hubTf = toHubTimeframe(tf);
    this.tfSeconds = timeframeToSeconds(tf);
    this.currentKey = nextKey;
    try {
      const connection = await this.hub.ensureConnected();
      if (token !== this.syncToken) return;
      this.connection = connection;
      this.connected = connection.state === signalR.HubConnectionState.Connected;
      this.candleEventHandler = (evt: any) => this.handleCandleEvent(evt);
      connection.on("candle_event", this.candleEventHandler);

      // Reconnect handler
      this.removeReconnectedListener = this.hub.addReconnectedListener(() => {
        if (this.syncToken !== token) return;
        void this.resubscribeAfterReconnect(src);
      });

      await this.requestTfSnapshot(connection, src, this.initialTfSnapshotCount);
      if (src === "quotes") {
        await connection.invoke("SubscribeCandles", this.currentSymbol, "1s", src);
      } else {
        await connection.invoke("SubscribeCandles", this.currentSymbol, this.hubTf || "1m", src);
        this.startTfSnapshotRefresh(connection, src);
      }
    } catch (error) {
      console.error("Failed to initialize divergence realtime chart", error);
      this.connected = false;
      if (!this.candles.length) this.error = stringifyError(error);
    } finally {
      if (token === this.syncToken) this.loading = false;
    }
  }

  private async resubscribeAfterReconnect(src: string): Promise<void> {
    const connection = this.connection;
    if (!connection || connection.state !== signalR.HubConnectionState.Connected) return;
    try {
      await this.requestTfSnapshot(connection, src, this.initialTfSnapshotCount);
      if (src === "quotes") {
        await connection.invoke("SubscribeCandles", this.currentSymbol, "1s", src);
      } else {
        await connection.invoke("SubscribeCandles", this.currentSymbol, this.hubTf || "1m", src);
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
    const src = this.currentSource;
    if (evtSource && evtSource !== src) return;

    // Snapshot — full render + indicators
    if (evt.type === "candle" && evt.eventType === "snapshot" && evt.tf === this.hubTf) {
      const lastTime = this.candles.length ? this.candles[this.candles.length - 1].time : null;
      const snapshot = (evt.candles || [])
        .map((c: any) => normalizeTfCandle(c, this.hubTimeOffsetSeconds, this.tfSeconds, lastTime))
        .filter((c: Candle | null): c is Candle => !!c)
        .sort((a: Candle, b: Candle) => a.time - b.time);
      if (!snapshot.length) return;
      this.captureIndicatorWarmup(snapshot);
      const filtered = this.filterIncomingCandlesForSeededHistory(snapshot);
      if (!filtered.length && this.candles.length) return;
      this.candles = this.candles.length ? mergeCandles(this.candles, filtered) : filtered;
      if (this.previewOnly) {
        // Preview receives a one-shot snapshot that can prepend older candles.
        // Reset the viewport so the final candle set is focused around the
        // divergence anchors instead of staying on stale logical indexes.
        this.autoFitApplied = false;
      }
      this.renderMarketDataFull();
      if (!this.tradeLevelsRendered) this.renderTradeLevels();
      this.renderTrendlines();

      // In preview mode, clean up after receiving the snapshot (no ongoing stream)
      if (this.previewOnly && this.connection && this.candleEventHandler) {
        this.connection.off("candle_event", this.candleEventHandler);
        this.candleEventHandler = null;
        this.connection = null;
        this.currentKey = "";
      }
      return;
    }

    // 1s candle — lightweight update: only price series, skip indicator recalc
    if (evt.type === "candle" && (evt.eventType === "candle_close" || evt.eventType === "candle_update") && evt.tf === "1s") {
      const candle = normalizeCandle(evt.candle, this.hubTimeOffsetSeconds);
      if (!candle) return;
      if (this.signalStopAfterTime !== null) {
        const bucketTime = Math.floor(candle.time / this.tfSeconds) * this.tfSeconds;
        if (bucketTime > this.signalStopAfterTime) return;
      }
      const isNewBucket = this.candles.length > 0 && Math.floor(candle.time / this.tfSeconds) * this.tfSeconds > this.candles[this.candles.length - 1].time;
      const result = updateLastTfCandle(this.candles, candle, this.tfSeconds, this.lastProcessed1sTime);
      this.candles = result.candles;
      this.lastProcessed1sTime = result.lastProcessed1sTime;

      if (isNewBucket) {
        // New candle formed — full indicator recalculation
        this.renderMarketDataFull();
      } else {
        // Same candle updating — only update price series
        this.renderPriceOnly();
      }
      return;
    }

    // TF candle — full render on close, price-only on update
    if (evt.type === "candle" && (evt.eventType === "candle_close" || evt.eventType === "candle_update") && evt.tf === this.hubTf) {
      if (src === "quotes") return;
      const lastTime = this.candles.length ? this.candles[this.candles.length - 1].time : null;
      const candle = normalizeTfCandle(evt.candle, this.hubTimeOffsetSeconds, this.tfSeconds, lastTime);
      if (!candle || !this.shouldAcceptIncomingCandle(candle)) return;
      const isNew = !this.candles.length || candle.time > this.candles[this.candles.length - 1].time;
      this.candles = upsertTfCandle(this.candles, candle);

      if (evt.eventType === "candle_close" || isNew) {
        this.renderMarketDataFull();
      } else {
        this.renderPriceOnly();
      }
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
      this.currentSymbol = "";
      this.currentSource = "";
      this.hubTf = "";
      this.tfSeconds = 300;
      return;
    }
    const connection = this.connection;
    const src = this.currentSource;
    if (this.candleEventHandler) {
      connection.off("candle_event", this.candleEventHandler);
      this.candleEventHandler = null;
    }
    if (this.currentSymbol && this.hubTf && src && connection.state === signalR.HubConnectionState.Connected) {
      try { await connection.invoke("UnsubscribeCandles", this.currentSymbol, this.hubTf, src); } catch (e) { console.error("Failed to unsubscribe divergence tf candles", e); }
      if (src === "quotes") {
        try { await connection.invoke("UnsubscribeCandles", this.currentSymbol, "1s", src); } catch (e) { console.error("Failed to unsubscribe divergence 1s candles", e); }
      }
    }
    this.connection = null;
    this.currentKey = "";
    this.currentSymbol = "";
    this.currentSource = "";
    this.hubTf = "";
    this.tfSeconds = 300;
    this.lastProcessed1sTime = null;
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  /** Full render: price + all indicators. Used on snapshot, candle_close, seed. */
  private renderMarketDataFull(): void {
    if (!this.priceSeries || !this.chartRef) return;
    const prevStopTime = this.signalStopAfterTime;
    if (this.signalCompleted && this.signalStopAfterTime === null) {
      this.tryComputeSignalStopTime();
    }
    if (this.signalStopAfterTime !== null && this.candles.length) {
      const trimIdx = this.candles.findIndex((c) => c.time > this.signalStopAfterTime!);
      if (trimIdx >= 0) this.candles = this.candles.slice(0, trimIdx);
    }
    if (prevStopTime === null && this.signalStopAfterTime !== null) {
      this.tradeLevelsRendered = false;
    }
    if (!this.candles.length) {
      this.priceSeries.setData([]);
      this.stochasticKSeries?.setData([]);
      this.stochasticDSeries?.setData([]);
      this.rsiSeries?.setData([]);
      this.macdHistogramSeries?.setData([]);
      this.macdSignalSeries?.setData([]);
      this.macdLineSeries?.setData([]);
      return;
    }
    this.error = null;
    if (!this.pricePrecisionApplied) {
      this.applyPriceFormat();
      this.pricePrecisionApplied = true;
    }
    this.priceSeries.setData(this.candles.map((c) => ({ time: toUtc(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));

    const indicatorCandles = this.getIndicatorInputCandles();
    if (this.stochasticKSeries && this.stochasticDSeries) {
      const stochastic = this.filterIndicatorSeriesToVisibleRange(calculateStochasticSeries(indicatorCandles, 5, 3, 3));
      this.stochasticKSeries.setData(stochastic.map((p) => ({ time: toUtc(p.time), value: p.k })));
      this.stochasticDSeries.setData(stochastic.map((p) => ({ time: toUtc(p.time), value: p.d })));
    }

    if (this.rsiSeries) {
      const rsi = this.filterIndicatorSeriesToVisibleRange(calculateRsiSeries(indicatorCandles, 14));
      this.rsiSeries.setData(rsi.map((p) => ({ time: toUtc(p.time), value: p.value })));
      this.publishIndicatorDebug("rsi", rsi);
    }

    if (this.macdHistogramSeries && this.macdSignalSeries && this.macdLineSeries) {
      const macd = this.filterIndicatorSeriesToVisibleRange(calculateMacdSeries(indicatorCandles, 12, 29, 9));
      this.macdHistogramSeries.setData(macd.map((p) => ({ time: toUtc(p.time), value: p.histogram, color: p.histogram >= 0 ? this.tradingViewPalette.macdPositive : this.tradingViewPalette.macdNegative })));
      this.macdSignalSeries.setData(macd.map((p) => ({ time: toUtc(p.time), value: p.signal })));
      this.macdLineSeries.setData(macd.map((p) => ({ time: toUtc(p.time), value: p.macd })));
    }

    if (!this.tradeLevelsRendered) {
      this.renderTradeLevels();
    } else if (!this.signalCompleted && this.candles.length && this.candles[this.candles.length - 1].time >= this.tradeLevelsEndTime) {
      this.renderTradeLevels();
    }
    this.handleAutoFitAndScroll();
    this.emitCurrentPrice();
  }

  /** Lightweight render: only updates price candlestick. Skips indicators. */
  private renderPriceOnly(): void {
    if (!this.priceSeries || !this.candles.length) return;
    const last = this.candles[this.candles.length - 1];
    try {
      this.priceSeries.update({ time: toUtc(last.time), open: last.open, high: last.high, low: last.low, close: last.close });
    } catch {
      // Fallback to full setData if update fails (e.g. time ordering issue)
      this.priceSeries.setData(this.candles.map((c) => ({ time: toUtc(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    }
    if (this.active && this.followRealtime && !this.previewOnly) {
      requestAnimationFrame(() => this.runWithSuppressedVisibleRangeTracking(() => this.chartRef?.timeScale().scrollToRealTime()));
    }
    this.emitCurrentPrice();
  }

  private handleAutoFitAndScroll(): void {
    if (!this.autoFitApplied) {
      const initialLogicalRange = this.previewOnly
        ? this.getInitialLogicalRange()
        : this.getLiveStartupLogicalRange();
      if (initialLogicalRange) {
        this.runWithSuppressedVisibleRangeTracking(() =>
          this.chartRef?.timeScale().setVisibleLogicalRange(initialLogicalRange),
        );
      } else {
        this.runWithSuppressedVisibleRangeTracking(() => this.chartRef?.timeScale().fitContent());
      }
      this.autoFitApplied = true;
      if (this.active && this.followRealtime && !this.previewOnly) {
        requestAnimationFrame(() => this.runWithSuppressedVisibleRangeTracking(() => this.chartRef?.timeScale().scrollToRealTime()));
      }
    } else if (this.active && this.followRealtime && !this.previewOnly) {
      requestAnimationFrame(() => this.runWithSuppressedVisibleRangeTracking(() => this.chartRef?.timeScale().scrollToRealTime()));
    }
  }

  // ── Trendlines ─────────────────────────────────────────────────────────

  private renderTrendlines(): void {
    if (!this.chartRef) return;
    const normalizedLines = this.normalizeTrendLines();
    this.removeTrendlines();
    const debugLines: Array<Record<string, unknown>> = [];
    for (const line of normalizedLines) {
      const paneIndex = this.mapTrendLinePaneIndexForCurrentLayout(line.paneIndex);
      const lineData = this.buildTrendLineData(line);
      if (this.trendlineDebugEnabled) {
        debugLines.push({
          originalPaneIndex: line.paneIndex,
          mappedPaneIndex: paneIndex,
          rayRight: line.rayRight,
          p1: line.p1,
          p2: line.p2,
          firstPoint: lineData[0] ?? null,
          lastPoint: lineData[lineData.length - 1] ?? null,
          pointsCount: lineData.length,
        });
      }
      if (paneIndex === null) {
        continue;
      }
      const series = this.chartRef.addSeries(LineSeries, {
        color: line.color, lineWidth: line.width,
        lineStyle: line.style === "dot" ? LineStyle.Dotted : LineStyle.Solid,
        lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false,
      }, paneIndex);
      series.setData(lineData);
      this.overlayLineSeries.push(series);
    }
    this.publishTrendlineDebug(debugLines);
  }

  private renderTradeLevels(): void {
    if (!this.chartRef || !this.priceSeries || !this.candles.length) return;
    this.removeTradeLevels();
    const entry = parsePrice(this.entryPrice);
    const target = parsePrice(this.takeProfit);
    const stop = parsePrice(this.stopOrder);
    if (entry === null && target === null && stop === null) return;
    const tfSec = timeframeToSeconds(normalizeDisplayTimeframe(this.timeframe) || "M5");
    const startTime = this.getTradeLevelsStartTime();
    const endTime = this.getTradeLevelsEndTime(tfSec);
    this.tradeLevelsEndTime = endTime;

    if (entry !== null && target !== null) {
      const series = this.chartRef.addSeries(BaselineSeries, {
        baseValue: { type: "price", price: entry },
        topFillColor1: target > entry ? "rgba(76,175,80,0.18)" : "rgba(0,0,0,0)",
        topFillColor2: target > entry ? "rgba(76,175,80,0.18)" : "rgba(0,0,0,0)",
        topLineColor: target > entry ? "rgba(76,175,80,0.9)" : "rgba(0,0,0,0)",
        bottomFillColor1: target < entry ? "rgba(76,175,80,0.18)" : "rgba(0,0,0,0)",
        bottomFillColor2: target < entry ? "rgba(76,175,80,0.18)" : "rgba(0,0,0,0)",
        bottomLineColor: target < entry ? "rgba(76,175,80,0.9)" : "rgba(0,0,0,0)",
        lineWidth: 1, priceLineVisible: false, lastValueVisible: false, baseLineVisible: false,
        autoscaleInfoProvider: () => null,
      }, 0);
      series.setData(this.buildBaselineData(startTime, endTime, target, tfSec));
      this.tradeLevelAreaSeries.push(series);
    }

    if (entry !== null && stop !== null) {
      const series = this.chartRef.addSeries(BaselineSeries, {
        baseValue: { type: "price", price: entry },
        topFillColor1: stop > entry ? "rgba(239,83,80,0.16)" : "rgba(0,0,0,0)",
        topFillColor2: stop > entry ? "rgba(239,83,80,0.16)" : "rgba(0,0,0,0)",
        topLineColor: stop > entry ? "rgba(239,83,80,0.9)" : "rgba(0,0,0,0)",
        bottomFillColor1: stop < entry ? "rgba(239,83,80,0.16)" : "rgba(0,0,0,0)",
        bottomFillColor2: stop < entry ? "rgba(239,83,80,0.16)" : "rgba(0,0,0,0)",
        bottomLineColor: stop < entry ? "rgba(239,83,80,0.9)" : "rgba(0,0,0,0)",
        lineWidth: 1, priceLineVisible: false, lastValueVisible: false, baseLineVisible: false,
        autoscaleInfoProvider: () => null,
      }, 0);
      series.setData(this.buildBaselineData(startTime, endTime, stop, tfSec));
      this.tradeLevelAreaSeries.push(series);
    }

    if (entry !== null) this.bindPriceLine(this.priceSeries, { price: entry, color: "#dc2626", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "Entry", lineVisible: true });
    if (target !== null) this.bindPriceLine(this.priceSeries, { price: target, color: "#18a67d", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "Target", lineVisible: true });
    if (stop !== null) this.bindPriceLine(this.priceSeries, { price: stop, color: "#ef5350", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "Stop", lineVisible: true });
    this.tradeLevelsRendered = true;
  }

  private createGuideLines(): void {
    this.removeGuideLines();
    if (this.stochasticKSeries) {
      this.bindGuideLine(this.stochasticKSeries, 80);
      this.bindGuideLine(this.stochasticKSeries, 20);
    }
    if (this.rsiSeries) {
      this.bindGuideLine(this.rsiSeries, 70);
      this.bindGuideLine(this.rsiSeries, 30);
    }
    if (this.macdSignalSeries) {
      this.bindGuideLine(this.macdSignalSeries, 0);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private bindGuideLine(series: AnySeries, price: number): void {
    const line = (series as any).createPriceLine({ price, color: "rgba(107,114,128,0.5)", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "", lineVisible: true });
    this.guideLines.push({ series, line });
  }

  private bindPriceLine(series: AnySeries, options: Record<string, unknown>): void {
    const line = (series as any).createPriceLine(options);
    this.priceLines.push({ series, line });
  }

  private getIndicatorPaneIndex(indicator: DivergenceIndicator): number {
    if (this.usesSingleIndicatorLayout) {
      return 1;
    }

    return this.getLegacyIndicatorPaneIndex(indicator);
  }

  private getLegacyIndicatorPaneIndex(indicator: DivergenceIndicator): number {
    switch (indicator) {
      case "stochastic":
        return 1;
      case "rsi":
        return 2;
      case "macd":
        return 3;
    }
  }

  private mapTrendLinePaneIndexForCurrentLayout(paneIndex: number): number | null {
    if (!this.usesSingleIndicatorLayout) {
      return paneIndex;
    }

    if (paneIndex === 0) {
      return 0;
    }

    const activePaneIndex = this.getLegacyIndicatorPaneIndex(this.resolvedActiveIndicator!);
    return paneIndex === activePaneIndex ? 1 : null;
  }

  private normalizeActiveIndicator(value: unknown): DivergenceIndicator | null {
    const normalized = `${value ?? ""}`.trim().toLowerCase();
    if (normalized === "stochastic" || normalized === "stoch") {
      return "stochastic";
    }
    if (normalized === "rsi") {
      return "rsi";
    }
    if (normalized === "macd") {
      return "macd";
    }

    return null;
  }

  private inferActiveIndicatorFromPayload(): DivergenceIndicator | null {
    const annotationPayload = this.resolveTrendLinePayload();
    const source = annotationPayload.trendLines.length
      ? annotationPayload.trendLines
      : annotationPayload.objects;

    if (!source.length) {
      return null;
    }

    const matchedIndicators = new Set<DivergenceIndicator>();
    for (const item of source) {
      const normalized = `${item?.pane ?? item?.panel ?? item?.indicator ?? ""}`.trim().toLowerCase();
      if (!normalized) {
        continue;
      }

      if (normalized.includes("stoch")) {
        matchedIndicators.add("stochastic");
      } else if (normalized.includes("rsi")) {
        matchedIndicators.add("rsi");
      } else if (normalized.includes("macd")) {
        matchedIndicators.add("macd");
      }
    }

    if (matchedIndicators.size !== 1) {
      return null;
    }

    const [matchedIndicator] = matchedIndicators;
    return matchedIndicator ?? null;
  }

  private filterIncomingCandlesForSeededHistory(incoming: Candle[]): Candle[] {
    return incoming.filter((c) => this.shouldAcceptIncomingCandle(c));
  }

  private shouldAcceptIncomingCandle(candle: Candle): boolean {
    if (this.signalStopAfterTime !== null && candle.time > this.signalStopAfterTime) return false;
    if (!this.seededFromChartData || this.seededHistoryEndTime === null) return true;
    // Accept candles BEFORE the seed range (pre-seed history)
    if (this.seededHistoryStartTime !== null && candle.time < this.seededHistoryStartTime) return true;
    // Accept candles AFTER the seed range (continuation)
    if (candle.time > this.seededHistoryEndTime) return true;
    // Reject candles within the seed range (seed data is authoritative)
    return false;
  }

  private captureIndicatorWarmup(snapshot: Candle[]): void {
    if (!this.seededFromChartData || !this.articleSeedCandles.length) {
      this.indicatorWarmupCandles = [];
      return;
    }
    const visibleStartTime = this.articleSeedCandles[0].time;
    const warmupSlice = snapshot.filter((c) => c.time < visibleStartTime);
    if (!warmupSlice.length) return;
    this.indicatorWarmupCandles = mergeCandles(this.indicatorWarmupCandles, warmupSlice).slice(-this.indicatorWarmupLimit);
  }

  private getIndicatorInputCandles(): Candle[] {
    return this.indicatorWarmupCandles.length ? mergeCandles(this.indicatorWarmupCandles, this.candles) : this.candles;
  }

  private filterIndicatorSeriesToVisibleRange<T extends { time: number }>(series: T[]): T[] {
    if (!series.length || !this.candles.length) return series;
    const visibleStartTime = this.candles[0].time;
    return series.filter((p) => p.time >= visibleStartTime);
  }

  private applyPriceFormat(): void {
    if (!this.priceSeries) return;
    const values = this.candles.flatMap((c) => [c.open, c.high, c.low, c.close]);
    const entry = parsePrice(this.entryPrice);
    const target = parsePrice(this.takeProfit);
    const stop = parsePrice(this.stopOrder);
    if (entry !== null) values.push(entry);
    if (target !== null) values.push(target);
    if (stop !== null) values.push(stop);
    const precision = inferPrecision(values);
    this.priceSeries.applyOptions({ priceFormat: { type: "price", precision, minMove: precision > 0 ? 1 / Math.pow(10, precision) : 1 } });
  }

  // ── Snapshot refresh ───────────────────────────────────────────────────

  private async requestTfSnapshot(connection: signalR.HubConnection, src: string, count: number): Promise<void> {
    if (!this.currentSymbol || !this.hubTf || !src || connection.state !== signalR.HubConnectionState.Connected) return;
    await connection.invoke("RequestCandlesSnapshot", this.currentSymbol, this.hubTf, src, count);
  }

  private startTfSnapshotRefresh(connection: signalR.HubConnection, src: string): void {
    this.stopTfSnapshotRefresh();
    if (!this.currentSymbol || !this.hubTf || !src || !this.isBrowser) return;
    this.tfSnapshotRefreshTimer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (!this.connection || this.connection !== connection || connection.state !== signalR.HubConnectionState.Connected) return;
      void this.requestTfSnapshot(connection, src, this.refreshTfSnapshotCount).catch((e: unknown) => console.warn("Failed to refresh divergence tf snapshot", e));
    }, 5000);
  }

  private stopTfSnapshotRefresh(): void {
    if (this.tfSnapshotRefreshTimer !== null) clearInterval(this.tfSnapshotRefreshTimer);
    this.tfSnapshotRefreshTimer = null;
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  private removeTrendlines(): void {
    if (!this.chartRef) { this.overlayLineSeries = []; return; }
    for (const s of this.overlayLineSeries) { try { this.chartRef.removeSeries(s); } catch (e) { console.warn("Failed to remove divergence trendline", e); } }
    this.overlayLineSeries = [];
  }

  private removeTradeLevels(): void {
    if (this.chartRef) {
      for (const s of this.tradeLevelAreaSeries) { try { this.chartRef.removeSeries(s); } catch (e) { console.warn("Failed to remove divergence trade level area", e); } }
    }
    this.tradeLevelAreaSeries = [];
    for (const b of this.priceLines) { try { (b.series as any).removePriceLine(b.line); } catch (e) { console.warn("Failed to remove divergence price line", e); } }
    this.priceLines = [];
  }

  private removeGuideLines(): void {
    for (const b of this.guideLines) { try { (b.series as any).removePriceLine(b.line); } catch (e) { console.warn("Failed to remove divergence guide line", e); } }
    this.guideLines = [];
  }

  private destroyChart(): void {
    if (!this.chartRef) return;
    if (this.visibleLogicalRangeHandler) {
      this.chartRef.timeScale().unsubscribeVisibleLogicalRangeChange(this.visibleLogicalRangeHandler);
      this.visibleLogicalRangeHandler = null;
    }
    this.chartRef.remove();
    this.chartRef = null;
    this.priceSeries = null;
    this.stochasticKSeries = null;
    this.stochasticDSeries = null;
    this.rsiSeries = null;
    this.macdHistogramSeries = null;
    this.macdSignalSeries = null;
    this.macdLineSeries = null;
  }

  private emitCurrentPrice(): void {
    const nextPrice = Number(this.candles[this.candles.length - 1]?.close);
    if (!Number.isFinite(nextPrice)) return;

    const roundedPrice = Math.round(nextPrice * 100000) / 100000;
    if (this.lastEmittedPrice === roundedPrice) return;

    this.lastEmittedPrice = roundedPrice;
    this.currentPriceChange.emit(roundedPrice);
  }

  // ── Visible range tracking ─────────────────────────────────────────────

  private handleVisibleLogicalRangeChange(range: LogicalRange | null): void {
    if (this.suppressVisibleRangeTracking || !range || !this.candles.length) return;
    const realtimeLogicalTo = this.candles.length - 1 + this.defaultRightOffsetBars;
    this.followRealtime = range.to >= realtimeLogicalTo - this.realtimeFollowThresholdBars;
  }

  private runWithSuppressedVisibleRangeTracking(action: () => void): void {
    this.suppressVisibleRangeTracking = true;
    try { action(); } finally {
      requestAnimationFrame(() => { this.suppressVisibleRangeTracking = false; });
    }
  }

  // ── Trendline normalization ────────────────────────────────────────────

  private normalizeTrendLines(): TrendLine[] {
    const annotationPayload = this.resolveTrendLinePayload();
    const source = annotationPayload.trendLines.length
      ? annotationPayload.trendLines
      : annotationPayload.objects;
    const normalized = source
      .map((l, i) => this.normalizeTrendLine(l, i))
      .filter((l: TrendLine | null): l is TrendLine => !!l);

    // Keep ray-right lines bounded by the first same-pane intersection, like pattern mode.
    for (const line of normalized) {
      if (!line.rayRight || line.style === "dot") continue;

      let earliestBarIdx = Infinity;
      let endValue: number | undefined;

      for (const candidate of normalized) {
        if (line === candidate || !candidate.rayRight || candidate.style === "dot") continue;
        if (line.paneIndex !== candidate.paneIndex) continue;
        if (Math.abs(line.slopePerBar - candidate.slopePerBar) < 1e-12) continue;

        const intersectionBarIdx =
          (candidate.intercept - line.intercept) /
          (line.slopePerBar - candidate.slopePerBar);
        if (
          intersectionBarIdx >
            Math.max(line.p1.barIdx, candidate.p1.barIdx) &&
          intersectionBarIdx < earliestBarIdx
        ) {
          earliestBarIdx = intersectionBarIdx;
          endValue = line.slopePerBar * intersectionBarIdx + line.intercept;
        }
      }

      if (earliestBarIdx !== Infinity && endValue !== undefined) {
        line.endBarIdx = earliestBarIdx;
        line.endValue = endValue;
      }
    }

    return normalized;
  }

  private normalizeTrendLine(rawLine: any, lineIndex: number): TrendLine | null {
    const rawType = `${rawLine?.type ?? rawLine?.Type ?? ""}`.trim().toLowerCase();
    if (rawType !== "trendline") return null;
    const rawPoints = Array.isArray(rawLine?.points)
      ? rawLine.points
      : Array.isArray(rawLine?.Points)
        ? rawLine.Points
        : [];
    if (rawPoints.length < 2) return null;
    const tfSec = timeframeToSeconds(normalizeDisplayTimeframe(this.timeframe) || "M5");
    const points = rawPoints
      .map((p: any) => {
        const time = this.readNumber(p, ["time", "Time"]);
        const value = this.readNumber(p, ["price", "Price", "value", "Value"]);
        if (time === null || value === null) return null;
        const barIdx = this.findNearestBarIndex(Number(toUtc(time)), tfSec);
        return barIdx >= 0 && Number.isFinite(value) ? { barIdx, value } : null;
      })
      .filter((p: { barIdx: number; value: number } | null): p is { barIdx: number; value: number } => p !== null)
      .sort((a: { barIdx: number }, b: { barIdx: number }) => a.barIdx - b.barIdx);
    if (points.length < 2) return null;
    const p1 = points[0];
    const p2 = points[points.length - 1];
    if (p1.barIdx === p2.barIdx) return null;
    const slopePerBar = (p2.value - p1.value) / (p2.barIdx - p1.barIdx);
    const intercept = p1.value - slopePerBar * p1.barIdx;
    return {
      color: String(rawLine?.color ?? "#42D433"),
      width: Math.min(Math.max(Number(rawLine?.width ?? 2), 1), 4) as 1 | 2 | 3 | 4,
      style: String(rawLine?.style ?? "solid").toLowerCase() === "dot" ? "dot" : "solid",
      rayRight: Boolean(rawLine?.ray_right ?? rawLine?.rayRight),
      paneIndex: this.resolveTrendLinePaneIndex(rawLine, points, lineIndex),
      p1, p2, slopePerBar,
      intercept,
    };
  }

  private resolveTrendLinePaneIndex(rawLine: any, points: Array<{ barIdx: number; value: number }>, lineIndex: number): number {
    const pane = `${rawLine?.pane ?? rawLine?.panel ?? ""}`.trim().toLowerCase();
    if (pane.includes("stoch")) return 1;
    if (pane.includes("rsi")) return 2;
    if (pane.includes("macd")) return 3;
    if (this.looksPriceLike(points)) return 0;
    const indicator = `${rawLine?.indicator ?? ""}`.trim().toLowerCase();
    if (indicator.includes("stoch")) return 1;
    if (indicator.includes("rsi")) return 2;
    if (indicator.includes("macd")) return 3;
    if (this.resolvedActiveIndicator) {
      return this.getLegacyIndicatorPaneIndex(this.resolvedActiveIndicator);
    }
    return lineIndex === 0 ? 0 : 2;
  }

  private findNearestBarIndex(rawTime: number, tfSec: number): number {
    const candles = this.getTrendLineCandles();
    if (!candles.length) return -1;
    let nearestIdx = 0;
    let nearestDist = Math.abs(candles[0].time - rawTime);
    for (let i = 1; i < candles.length; i++) {
      const d = Math.abs(candles[i].time - rawTime);
      if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
    }
    return nearestDist <= tfSec ? nearestIdx : -1;
  }

  private looksPriceLike(points: Array<{ value: number }>): boolean {
    const candles = this.getTrendLineCandles();
    if (!candles.length) return false;
    let minP = Infinity, maxP = -Infinity;
    for (const c of candles) { minP = Math.min(minP, c.low); maxP = Math.max(maxP, c.high); }
    const padding = Math.max((maxP - minP) * 0.25, this.getPriceMinMove() * 10);
    return points.every((p) => p.value >= minP - padding && p.value <= maxP + padding);
  }

  private getPriceMinMove(): number {
    const precision = inferPrecision(this.candles.flatMap((c) => [c.open, c.high, c.low, c.close]));
    return precision > 0 ? 1 / Math.pow(10, precision) : 1;
  }

  // ── Data builders ──────────────────────────────────────────────────────

  private buildTrendLineData(line: TrendLine): Array<{ time: UTCTimestamp; value: number }> {
    const candles = this.getTrendLineCandles();
    const n = candles.length;
    if (!n) return [];
    const data: Array<{ time: UTCTimestamp; value: number }> = [];
    let lastBar: number;
    if (!line.rayRight) {
      lastBar = line.p2.barIdx;
    } else if (line.endBarIdx !== undefined) {
      lastBar = this.previewOnly ? Math.min(Math.floor(line.endBarIdx), n - 1) : Math.floor(line.endBarIdx);
    } else {
      // Divergence payload often contains only one ray-right line per pane,
      // so there may be no intersection to stop on. In that case keep the
      // line alive through the visible candle history instead of truncating it
      // to a fixed +15 bars from the second point.
      lastBar = this.previewOnly ? Math.max(line.p2.barIdx, n - 1) : Math.max(line.p2.barIdx + 15, n - 1);
    }

    for (let i = line.p1.barIdx; i <= lastBar; i++) {
      const value = line.p1.value + line.slopePerBar * (i - line.p1.barIdx);
      if (i < n) {
        data.push({ time: candles[i].time as UTCTimestamp, value });
      } else {
        const t = candles[n - 1].time + (i - n + 1) * this.tfSeconds;
        data.push({ time: Math.round(t) as UTCTimestamp, value });
      }
    }

    return data;
  }

  private getTrendLineCandles(): Candle[] {
    return this.candles.length ? this.candles : this.articleSeedCandles;
  }

  private getInitialLogicalRange(): LogicalRange | null {
    const candles = this.getTrendLineCandles();
    if (!candles.length) {
      return null;
    }

    return buildFocusedLogicalRange(candles.length, this.collectInitialFocusAnchorBars(), {
      fallbackEndBar: candles.length - 1,
      minVisibleBars: 28,
      maxVisibleBars: 46,
      leftPaddingBars: 6,
      rightPaddingBars: 1,
      rightOffsetBars: 0,
    });
  }

  private getLiveStartupLogicalRange(): LogicalRange | null {
    const candles = this.getTrendLineCandles();
    if (!candles.length) {
      return null;
    }

    const focusedRange = this.getInitialLogicalRange();
    const visibleBars = getLogicalRangeSpan(focusedRange) ?? 32;
    return buildTrailingLogicalRange(candles.length, visibleBars, {
      rightOffsetBars: this.defaultRightOffsetBars,
    });
  }

  private collectInitialFocusAnchorBars(): number[] {
    const candles = this.getTrendLineCandles();
    const anchorBars = [candles.length - 1];

    for (const line of this.normalizeTrendLines()) {
      anchorBars.push(line.p1.barIdx, line.p2.barIdx);
      if (line.endBarIdx !== undefined && Number.isFinite(line.endBarIdx)) {
        anchorBars.push(Math.ceil(line.endBarIdx));
      }
    }

    if (this.signalCrossingTime !== null) {
      const crossingBarIdx = this.findNearestBarIndex(this.signalCrossingTime, this.tfSeconds);
      if (crossingBarIdx >= 0) {
        anchorBars.push(crossingBarIdx);
      }
    }

    return anchorBars;
  }

  private buildBaselineData(startTime: number, endTime: number, value: number, tfSec: number): Array<{ time: UTCTimestamp; value: number }> {
    if (endTime <= startTime) return [{ time: toUtc(startTime), value }];

    const points: Array<{ time: UTCTimestamp; value: number }> = [{ time: toUtc(startTime), value }];
    let lastTime = Number(toUtc(startTime));

    // Use real candle times for intermediate points
    for (const c of this.candles) {
      if (c.time > startTime && c.time < endTime && c.time !== lastTime) {
        points.push({ time: c.time as UTCTimestamp, value });
        lastTime = c.time;
      }
    }

    // Extend beyond last candle if needed
    const lastCandleTime = this.candles.length ? this.candles[this.candles.length - 1].time : startTime;
    if (endTime > lastCandleTime) {
      let t = lastCandleTime + tfSec;
      while (t < endTime) {
        const rounded = Math.round(t);
        if (t > startTime && rounded !== lastTime) {
          points.push({ time: rounded as UTCTimestamp, value });
          lastTime = rounded;
        }
        t += tfSec;
      }
    }

    const endUtc = Number(toUtc(endTime));
    if (endUtc !== lastTime) {
      points.push({ time: endUtc as UTCTimestamp, value });
    }

    return points;
  }

  private getTradeLevelsEndTime(tfSec: number): number {
    if (this.signalCompleted && this.signalCrossingTime !== null) return this.signalCrossingTime;
    if (this.previewOnly) return this.candles[this.candles.length - 1]?.time ?? Math.floor(Date.now() / 1000);
    return (this.candles[this.candles.length - 1]?.time ?? Math.floor(Date.now() / 1000)) + tfSec * 15;
  }

  private getTradeLevelsStartTime(): number {
    if (this.seededHistoryEndTime !== null) return this.seededHistoryEndTime;
    if (this.articleSeedCandles.length) return this.articleSeedCandles[this.articleSeedCandles.length - 1].time;
    return this.candles[this.candles.length - 1]?.time ?? Math.floor(Date.now() / 1000);
  }

  // ── Date formatting ────────────────────────────────────────────────────

  private formatHoverDate(time: unknown): string {
    const epochSeconds = this.extractChartEpochSeconds(time);
    if (epochSeconds === null) return "";
    const d = new Date(epochSeconds * 1000);
    const day = `${d.getUTCDate()}`.padStart(2, "0");
    const month = `${d.getUTCMonth() + 1}`.padStart(2, "0");
    const year = d.getUTCFullYear();
    if (this.tfSeconds >= 86400) return `${day}.${month}.${year}`;
    const hours = `${d.getUTCHours()}`.padStart(2, "0");
    const minutes = `${d.getUTCMinutes()}`.padStart(2, "0");
    if (this.tfSeconds >= 60) return `${day}.${month}.${year} ${hours}:${minutes}`;
    const seconds = `${d.getUTCSeconds()}`.padStart(2, "0");
    return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
  }

  private extractChartEpochSeconds(time: unknown): number | null {
    if (typeof time === "number" || typeof time === "string") {
      const value = Number(time);
      return Number.isFinite(value) ? Number(toUtc(value)) : null;
    }
    if (time && typeof time === "object") {
      const y = Number((time as any).year), m = Number((time as any).month), d = Number((time as any).day);
      if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) return Math.floor(Date.UTC(y, m - 1, d) / 1000);
    }
    return null;
  }

  // ── Local helpers (trendline-specific, not shared) ─────────────────────

  private readNumber(source: any, keys: string[]): number | null {
    for (const key of keys) {
      const value = source?.[key];
      if (value === null || value === undefined || value === "") continue;
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
    return null;
  }

  private publishTrendlineDebug(lines: Array<Record<string, unknown>>): void {
    if (!this.trendlineDebugEnabled || typeof window === "undefined") {
      return;
    }

    const payload = {
      symbol: this.symbol,
      timeframe: this.timeframe,
      activeIndicator: this.resolvedActiveIndicator,
      usesSingleIndicatorLayout: this.usesSingleIndicatorLayout,
      usedCachedAnnotations: this.usedCachedAnnotationsForLastRender,
      candlesCount: this.candles.length,
      firstCandleTime: this.candles[0]?.time ?? null,
      lastCandleTime: this.candles[this.candles.length - 1]?.time ?? null,
      lines,
    };

    (window as Window & { __rtwTrendlines?: unknown }).__rtwTrendlines = payload;
  }

  private publishIndicatorDebug(name: "rsi", points: Array<{ time: number; value: number }>): void {
    if (!this.trendlineDebugEnabled || typeof window === "undefined") {
      return;
    }

    const payload = {
      symbol: this.symbol,
      timeframe: this.timeframe,
      activeIndicator: this.resolvedActiveIndicator,
      lastPoints: points.slice(-5),
    };

    (window as Window & { __rtwIndicators?: Record<string, unknown> }).__rtwIndicators = {
      ...((window as Window & { __rtwIndicators?: Record<string, unknown> }).__rtwIndicators ?? {}),
      [name]: payload,
    };
  }

  private resolveTrendLinePayload(): { trendLines: any[]; objects: any[] } {
    const cacheKey = this.getAnnotationCacheKey();
    const currentTrendLines = Array.isArray(this.trendLines) ? this.trendLines : [];
    const currentObjects = Array.isArray(this.objects) ? this.objects : [];
    const hasCurrentAnnotations = currentTrendLines.length > 0 || currentObjects.length > 0;

    if (hasCurrentAnnotations) {
      this.annotationCache = {
        key: cacheKey,
        trendLines: currentTrendLines.length ? [...currentTrendLines] : null,
        objects: currentObjects.length ? [...currentObjects] : null,
      };
      this.usedCachedAnnotationsForLastRender = false;
      return { trendLines: currentTrendLines, objects: currentObjects };
    }

    if (this.annotationCache?.key === cacheKey) {
      this.usedCachedAnnotationsForLastRender = true;
      return {
        trendLines: Array.isArray(this.annotationCache.trendLines) ? this.annotationCache.trendLines : [],
        objects: Array.isArray(this.annotationCache.objects) ? this.annotationCache.objects : [],
      };
    }

    this.annotationCache = null;
    this.usedCachedAnnotationsForLastRender = false;
    return { trendLines: [], objects: [] };
  }

  private getAnnotationCacheKey(): string {
    const normalizedSymbol = normalizeSymbol(this.symbol);
    const normalizedTimeframe = normalizeDisplayTimeframe(this.timeframe) || `${this.timeframe ?? ""}`.trim().toUpperCase();
    return `${normalizedSymbol}|${normalizedTimeframe}`;
  }
}
