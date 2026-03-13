import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
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
  type UTCTimestamp,
} from "lightweight-charts";
import {
  calculateMacdSeries,
  calculateRsiSeries,
  calculateStochasticSeries,
  type IndicatorCandle,
} from "./divergence-indicators";
import { QuotesHubConnectionService } from "./quotes-hub-connection.service";

type Candle = IndicatorCandle;
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
  p1: { time: number; value: number };
  p2: { time: number; value: number };
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
  @Input() symbol = "";
  @Input() timeframe = "M15";
  @Input() source = "ohlc";
  @Input() active = false;
  @Input() height = 700;
  @Input() initialCandles: any[] | null = null;
  @Input() trendLines: any[] | null = null;
  @Input() objects: any[] | null = null;
  @Input() takeProfit: string | null = null;
  @Input() stopOrder: string | null = null;
  @Input() entryPrice: string | null = null;
  @Input() hubTimeOffsetHours = 2;

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
  private tfSnapshotRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private candles: Candle[] = [];
  private articleSeedCandles: Candle[] = [];
  private indicatorWarmupCandles: Candle[] = [];
  private seededFromChartData = false;
  private seededHistoryEndTime: number | null = null;
  private viewInitialized = false;
  private autoFitApplied = false;
  private currentSymbol = "";
  private currentSource = "";
  private hubTimeframe = "";
  private timeframeSeconds = 300;
  private currentKey = "";
  private syncToken = 0;
  private readonly initialTfSnapshotCount = 300;
  private readonly refreshTfSnapshotCount = 5;
  private readonly indicatorWarmupLimit = 300;

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
    if (changes["height"] && this.chartRef) this.chartRef.applyOptions({ height: this.height });
    if (changes["initialCandles"]) this.seedInitialCandles();
    if (changes["trendLines"] || changes["objects"] || changes["timeframe"]) this.renderTrendlines();
    if (changes["entryPrice"] || changes["takeProfit"] || changes["stopOrder"] || changes["timeframe"] || changes["initialCandles"]) this.renderTradeLevels();
    if (changes["symbol"] || changes["timeframe"] || changes["source"] || changes["active"] || changes["hubTimeOffsetHours"]) void this.syncRealtime();
  }

  ngOnDestroy(): void {
    void this.teardownRealtime();
    this.removeTrendlines();
    this.removeTradeLevels();
    this.removeGuideLines();
    this.destroyChart();
  }

  private createChart(): void {
    if (!this.chartContainerRef?.nativeElement) return;
    const chart = createChart(this.chartContainerRef.nativeElement, {
      autoSize: true,
      height: this.height,
      layout: { background: { type: ColorType.Solid, color: "#ffffff" }, textColor: "#111827" },
      localization: {
        locale: "ru-RU",
        timeFormatter: (time: unknown) => this.formatHoverDate(time),
      },
      grid: {
        vertLines: { visible: true, color: "rgba(17,24,39,0.08)" },
        horzLines: { visible: true, color: "rgba(17,24,39,0.08)" },
      },
      rightPriceScale: { visible: true, borderVisible: false, scaleMargins: { top: 0.06, bottom: 0.06 } },
      leftPriceScale: { visible: false },
      timeScale: {
        rightBarStaysOnScroll: true,
        barSpacing: 10,
        rightOffset: 3,
        borderVisible: false,
        tickMarkFormatter: (time: unknown) => this.formatAxisDate(time),
      },
      crosshair: {
        vertLine: { width: 1, color: "rgba(17,24,39,0.25)" },
        horzLine: { width: 1, color: "rgba(17,24,39,0.25)" },
      },
    });
    while (chart.panes().length < 4) chart.addPane(true);
    chart.panes()[0]?.setStretchFactor(6);
    chart.panes()[1]?.setStretchFactor(2);
    chart.panes()[2]?.setStretchFactor(2);
    chart.panes()[3]?.setStretchFactor(2.5);
    this.priceSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#ffffff",
      downColor: "#111111",
      borderUpColor: "#111111",
      borderDownColor: "#111111",
      wickUpColor: "#111111",
      wickDownColor: "#111111",
      lastValueVisible: true,
      priceLineVisible: false,
    }, 0);
    this.stochasticKSeries = chart.addSeries(LineSeries, {
      color: "#0f8f8a", lineWidth: 2, lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false,
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
    }, 1);
    this.stochasticDSeries = chart.addSeries(LineSeries, {
      color: "#d32f2f", lineWidth: 2, lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false,
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
    }, 1);
    this.rsiSeries = chart.addSeries(LineSeries, {
      color: "#2f80ff", lineWidth: 2, lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false,
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
    }, 2);
    this.macdHistogramSeries = chart.addSeries(HistogramSeries, { base: 0, color: "#444444", lastValueVisible: false, priceLineVisible: false }, 3);
    this.macdSignalSeries = chart.addSeries(LineSeries, { color: "#d32f2f", lineWidth: 2, lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false }, 3);
    this.macdLineSeries = chart.addSeries(LineSeries, { color: "#9ca3af", lineWidth: 2, lineStyle: LineStyle.Dotted, lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false }, 3);
    chart.priceScale("right", 1).applyOptions({ autoScale: false, scaleMargins: { top: 0.08, bottom: 0.08 } });
    chart.priceScale("right", 2).applyOptions({ autoScale: false, scaleMargins: { top: 0.08, bottom: 0.08 } });
    chart.priceScale("right", 3).applyOptions({ autoScale: true, scaleMargins: { top: 0.12, bottom: 0.12 } });
    this.chartRef = chart;
    this.createGuideLines();
  }

  private seedInitialCandles(): void {
    this.articleSeedCandles = this.normalizeCandles(this.initialCandles);
    this.indicatorWarmupCandles = [];
    this.seededFromChartData = this.articleSeedCandles.length > 0;
    this.seededHistoryEndTime = this.seededFromChartData ? this.articleSeedCandles[this.articleSeedCandles.length - 1].time : null;
    if (this.seededFromChartData) {
      this.candles = [...this.articleSeedCandles];
      this.error = null;
      this.autoFitApplied = false;
      this.renderMarketData();
    } else if (!this.active) {
      this.candles = [];
      this.renderMarketData();
    }
  }

  private async syncRealtime(): Promise<void> {
    const token = ++this.syncToken;
    const symbol = this.normalizeSymbol(this.symbol);
    const tf = this.normalizeDisplayTimeframe(this.timeframe);
    const source = this.normalizeSource(this.source);
    if (!this.active || !symbol || !tf || !source) {
      await this.teardownRealtime();
      if (token !== this.syncToken) return;
      this.loading = false;
      this.connected = false;
      if (!this.candles.length && !this.seededFromChartData) this.error = "No candle data provided for divergence chart.";
      return;
    }
    const nextKey = `${symbol}|${tf}|${source}|${this.hubTimeOffsetSeconds}`;
    if (this.currentKey === nextKey && this.connection && this.candleEventHandler) return;
    await this.teardownRealtime();
    if (token !== this.syncToken) return;
    this.loading = !this.candles.length;
    this.error = null;
    this.currentSymbol = symbol;
    this.currentSource = source;
    this.hubTimeframe = this.toHubTimeframe(tf);
    this.timeframeSeconds = this.timeframeToSeconds(tf);
    this.currentKey = nextKey;
    try {
      const connection = await this.hub.ensureConnected();
      if (token !== this.syncToken) return;
      this.connection = connection;
      this.connected = connection.state === signalR.HubConnectionState.Connected;
      this.candleEventHandler = (evt: any) => this.handleCandleEvent(evt);
      connection.on("candle_event", this.candleEventHandler);
      await this.requestTfSnapshot(connection, source, this.initialTfSnapshotCount);
      if (source === "quotes") {
        await connection.invoke("SubscribeCandles", this.currentSymbol, "1s", source);
      } else {
        await connection.invoke("SubscribeCandles", this.currentSymbol, this.hubTimeframe || "1m", source);
        this.startTfSnapshotRefresh(connection, source);
      }
    } catch (error) {
      console.error("Failed to initialize divergence realtime chart", error);
      this.connected = false;
      if (!this.candles.length) this.error = this.stringifyError(error);
    } finally {
      if (token === this.syncToken) this.loading = false;
    }
  }

  private handleCandleEvent(evt: any): void {
    if (!evt || evt.symbol !== this.currentSymbol) return;
    const evtSource = this.normalizeSource(evt.source || "");
    const source = this.currentSource;
    if (evtSource && evtSource !== source) return;
    if (evt.type === "candle" && evt.eventType === "snapshot" && evt.tf === this.hubTimeframe) {
      const snapshot = (evt.candles || [])
        .map((c: any) => this.normalizeTfCandle(c, this.hubTimeOffsetSeconds))
        .filter((c: Candle | null): c is Candle => !!c)
        .sort((l: Candle, r: Candle) => l.time - r.time);
      if (!snapshot.length) return;
      this.captureIndicatorWarmup(snapshot);
      const filtered = this.filterIncomingCandlesForSeededHistory(snapshot);
      if (!filtered.length && this.candles.length) return;
      this.candles = this.candles.length ? this.mergeCandles(this.candles, filtered) : filtered;
      this.renderMarketData();
      this.renderTradeLevels();
      if (!this.overlayLineSeries.length) this.renderTrendlines();
      return;
    }
    if (evt.type === "candle" && (evt.eventType === "candle_close" || evt.eventType === "candle_update") && evt.tf === "1s") {
      const candle = this.normalizeCandle(evt.candle, this.hubTimeOffsetSeconds);
      if (!candle) return;
      this.candles = this.updateLastTfCandle(this.candles, candle, this.timeframeSeconds);
      this.renderMarketData();
      this.renderTradeLevels();
      return;
    }
    if (evt.type === "candle" && (evt.eventType === "candle_close" || evt.eventType === "candle_update") && evt.tf === this.hubTimeframe) {
      if (source === "quotes") return;
      const candle = this.normalizeTfCandle(evt.candle, this.hubTimeOffsetSeconds);
      if (!candle || !this.shouldAcceptIncomingCandle(candle)) return;
      this.candles = this.upsertTfCandle(this.candles, candle);
      this.renderMarketData();
      this.renderTradeLevels();
    }
  }

  private async teardownRealtime(): Promise<void> {
    this.stopTfSnapshotRefresh();
    if (!this.connection) {
      this.candleEventHandler = null;
      this.currentKey = "";
      this.currentSymbol = "";
      this.currentSource = "";
      this.hubTimeframe = "";
      this.timeframeSeconds = 300;
      return;
    }
    const connection = this.connection;
    const source = this.currentSource;
    if (this.candleEventHandler) {
      connection.off("candle_event", this.candleEventHandler);
      this.candleEventHandler = null;
    }
    if (this.currentSymbol && this.hubTimeframe && source && connection.state === signalR.HubConnectionState.Connected) {
      try { await connection.invoke("UnsubscribeCandles", this.currentSymbol, this.hubTimeframe, source); } catch (error) { console.error("Failed to unsubscribe divergence tf candles", error); }
      if (source === "quotes") {
        try { await connection.invoke("UnsubscribeCandles", this.currentSymbol, "1s", source); } catch (error) { console.error("Failed to unsubscribe divergence 1s candles", error); }
      }
    }
    this.connection = null;
    this.currentKey = "";
    this.currentSymbol = "";
    this.currentSource = "";
    this.hubTimeframe = "";
    this.timeframeSeconds = 300;
  }

  private renderMarketData(): void {
    if (!this.priceSeries || !this.stochasticKSeries || !this.stochasticDSeries || !this.rsiSeries || !this.macdHistogramSeries || !this.macdSignalSeries || !this.macdLineSeries || !this.chartRef) return;
    if (!this.candles.length) {
      this.priceSeries.setData([]);
      this.stochasticKSeries.setData([]);
      this.stochasticDSeries.setData([]);
      this.rsiSeries.setData([]);
      this.macdHistogramSeries.setData([]);
      this.macdSignalSeries.setData([]);
      this.macdLineSeries.setData([]);
      return;
    }
    this.error = null;
    this.applyPriceFormat();
    this.priceSeries.setData(this.candles.map((c) => ({ time: this.toUtc(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    const indicatorCandles = this.getIndicatorInputCandles();
    const stochastic = this.filterIndicatorSeriesToVisibleRange(calculateStochasticSeries(indicatorCandles, 5, 3, 3));
    this.stochasticKSeries.setData(stochastic.map((p) => ({ time: this.toUtc(p.time), value: p.k })));
    this.stochasticDSeries.setData(stochastic.map((p) => ({ time: this.toUtc(p.time), value: p.d })));
    const rsi = this.filterIndicatorSeriesToVisibleRange(calculateRsiSeries(indicatorCandles, 14));
    this.rsiSeries.setData(rsi.map((p) => ({ time: this.toUtc(p.time), value: p.value })));
    const macd = this.filterIndicatorSeriesToVisibleRange(calculateMacdSeries(indicatorCandles, 12, 29, 9));
    this.macdHistogramSeries.setData(macd.map((p) => ({ time: this.toUtc(p.time), value: p.histogram, color: p.histogram >= 0 ? "#444444" : "#666666" })));
    this.macdSignalSeries.setData(macd.map((p) => ({ time: this.toUtc(p.time), value: p.signal })));
    this.macdLineSeries.setData(macd.map((p) => ({ time: this.toUtc(p.time), value: p.macd })));
    if (!this.autoFitApplied) {
      this.chartRef.timeScale().fitContent();
      this.autoFitApplied = true;
    } else if (this.active) {
      requestAnimationFrame(() => this.chartRef?.timeScale().scrollToRealTime());
    }
  }

  private renderTrendlines(): void {
    if (!this.chartRef) return;
    this.removeTrendlines();
    for (const line of this.normalizeTrendLines()) {
      const series = this.chartRef.addSeries(LineSeries, {
        color: line.color,
        lineWidth: line.width,
        lineStyle: line.style === "dot" ? LineStyle.Dotted : LineStyle.Solid,
        lastValueVisible: false,
        priceLineVisible: false,
        pointMarkersVisible: false,
      }, line.paneIndex);
      series.setData(this.buildTrendLineData(line));
      this.overlayLineSeries.push(series);
    }
  }

  private renderTradeLevels(): void {
    if (!this.chartRef || !this.priceSeries || !this.candles.length) return;
    this.removeTradeLevels();
    const entry = this.parsePrice(this.entryPrice);
    const target = this.parsePrice(this.takeProfit);
    const stop = this.parsePrice(this.stopOrder);
    if (entry === null && target === null && stop === null) return;
    const tfSeconds = this.timeframeToSeconds(this.normalizeDisplayTimeframe(this.timeframe) || "M5");
    const startIndex = Math.max(this.candles.length - 10, 0);
    const startTime = this.candles[startIndex].time;
    const endTime = this.getTradeLevelsEndTime(tfSeconds);
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
      series.setData(this.buildBaselineData(startTime, endTime, target, tfSeconds));
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
      series.setData(this.buildBaselineData(startTime, endTime, stop, tfSeconds));
      this.tradeLevelAreaSeries.push(series);
    }
    if (entry !== null) this.bindPriceLine(this.priceSeries, { price: entry, color: "#dc2626", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "Entry", lineVisible: true });
    if (target !== null) this.bindPriceLine(this.priceSeries, { price: target, color: "#18a67d", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "Target", lineVisible: true });
    if (stop !== null) this.bindPriceLine(this.priceSeries, { price: stop, color: "#ef5350", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "Stop", lineVisible: true });
  }

  private createGuideLines(): void {
    if (!this.stochasticKSeries || !this.rsiSeries || !this.macdSignalSeries) return;
    this.removeGuideLines();
    this.bindGuideLine(this.stochasticKSeries, 80);
    this.bindGuideLine(this.stochasticKSeries, 20);
    this.bindGuideLine(this.rsiSeries, 70);
    this.bindGuideLine(this.rsiSeries, 30);
    this.bindGuideLine(this.macdSignalSeries, 0);
  }

  private bindGuideLine(series: AnySeries, price: number): void {
    const line = (series as any).createPriceLine({
      price,
      color: "rgba(107,114,128,0.5)",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: false,
      title: "",
      lineVisible: true,
    });
    this.guideLines.push({ series, line });
  }

  private bindPriceLine(series: AnySeries, options: Record<string, unknown>): void {
    const line = (series as any).createPriceLine(options);
    this.priceLines.push({ series, line });
  }

  private normalizeCandles(rawCandles: any[] | null): Candle[] {
    return (Array.isArray(rawCandles) ? rawCandles : [])
      .map((candle) => this.normalizeCandle(candle))
      .filter((candle: Candle | null): candle is Candle => !!candle)
      .sort((left: Candle, right: Candle) => left.time - right.time);
  }

  private normalizeCandle(candle: any, timeOffsetSeconds = 0): Candle | null {
    if (!candle) return null;
    const time = this.readNumber(candle, ["time", "Time", "t", "T"]);
    const open = this.readNumber(candle, ["open", "Open", "o", "O"]);
    const high = this.readNumber(candle, ["high", "High", "h", "H"]);
    const low = this.readNumber(candle, ["low", "Low", "l", "L"]);
    const close = this.readNumber(candle, ["close", "Close", "c", "C"]);
    const volume = this.readOptionalNumber(candle, ["volume", "Volume", "v", "V"]);
    if (time === null || open === null || high === null || low === null || close === null) return null;
    return { time: Number(this.toUtc(time)) + timeOffsetSeconds, open, high, low, close, volume };
  }

  private normalizeTfCandle(candle: any, timeOffsetSeconds = 0): Candle | null {
    const normalized = this.normalizeCandle(candle, timeOffsetSeconds);
    return normalized ? { ...normalized, time: this.normalizeTfTimestamp(normalized.time) } : null;
  }

  private normalizeTfTimestamp(rawTime: number): number {
    const raw = Number(this.toUtc(rawTime));
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    const tfSec = Math.max(1, this.timeframeSeconds || 60);
    const bucketStart = Math.floor(raw / tfSec) * tfSec;
    const lastLocalTime = this.candles.length ? this.candles[this.candles.length - 1].time : null;
    if (raw % tfSec === 0 && lastLocalTime !== null && lastLocalTime === raw - tfSec) return raw - tfSec;
    return bucketStart;
  }

  private normalizeTrendLines(): TrendLine[] {
    const source = Array.isArray(this.trendLines) && this.trendLines.length ? this.trendLines : Array.isArray(this.objects) ? this.objects : [];
    return source.map((line, index) => this.normalizeTrendLine(line, index)).filter((line: TrendLine | null): line is TrendLine => !!line);
  }

  private normalizeTrendLine(rawLine: any, lineIndex: number): TrendLine | null {
    if (rawLine?.type !== "trendline") return null;
    const rawPoints = Array.isArray(rawLine?.points) ? rawLine.points : [];
    if (rawPoints.length < 2) return null;
    const points = rawPoints
      .map((point: any) => {
        const time = this.readNumber(point, ["time", "Time"]);
        const value = this.readNumber(point, ["price", "Price", "value", "Value"]);
        return time === null || value === null ? null : { time: this.resolveTrendLineTime(Number(this.toUtc(time))), value };
      })
      .filter((point: { time: number; value: number } | null): point is { time: number; value: number } => !!point && point.time > 0 && Number.isFinite(point.value))
      .sort(
        (
          left: { time: number; value: number },
          right: { time: number; value: number },
        ) => left.time - right.time,
      );
    if (points.length < 2) return null;
    return {
      color: String(rawLine?.color ?? "#42D433"),
      width: Math.min(Math.max(Number(rawLine?.width ?? 2), 1), 4) as 1 | 2 | 3 | 4,
      style: String(rawLine?.style ?? "solid").toLowerCase() === "dot" ? "dot" : "solid",
      rayRight: !!rawLine?.ray_right,
      paneIndex: this.resolveTrendLinePaneIndex(rawLine, points, lineIndex),
      p1: points[0],
      p2: points[points.length - 1],
    };
  }

  private resolveTrendLinePaneIndex(rawLine: any, points: Array<{ time: number; value: number }>, lineIndex: number): number {
    const pane = `${rawLine?.pane ?? rawLine?.panel ?? ""}`.trim().toLowerCase();
    if (pane.includes("stoch")) return 1;
    if (pane.includes("rsi")) return 2;
    if (pane.includes("macd")) return 3;
    if (this.looksPriceLike(points)) return 0;
    const indicator = `${rawLine?.indicator ?? ""}`.trim().toLowerCase();
    if (indicator.includes("stoch")) return 1;
    if (indicator.includes("rsi")) return 2;
    if (indicator.includes("macd")) return 3;
    return lineIndex === 0 ? 0 : 2;
  }

  private resolveTrendLineTime(rawTime: number): number {
    const candles = this.articleSeedCandles.length ? this.articleSeedCandles : this.candles;
    if (!candles.length) return rawTime;
    const tfSeconds = this.timeframeToSeconds(this.normalizeDisplayTimeframe(this.timeframe) || "M5");
    let nearestTime = candles[0].time;
    let nearestDistance = Math.abs(nearestTime - rawTime);
    for (const candle of candles) {
      const distance = Math.abs(candle.time - rawTime);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestTime = candle.time;
      }
    }
    return nearestDistance <= tfSeconds ? nearestTime : rawTime;
  }

  private looksPriceLike(points: Array<{ value: number }>): boolean {
    const candles = this.articleSeedCandles.length ? this.articleSeedCandles : this.candles;
    if (!candles.length) return false;
    let minPrice = Number.POSITIVE_INFINITY;
    let maxPrice = Number.NEGATIVE_INFINITY;
    for (const candle of candles) {
      minPrice = Math.min(minPrice, candle.low);
      maxPrice = Math.max(maxPrice, candle.high);
    }
    const padding = Math.max((maxPrice - minPrice) * 0.25, this.getPriceMinMove() * 10);
    return points.every((point) => point.value >= minPrice - padding && point.value <= maxPrice + padding);
  }

  private buildTrendLineData(line: TrendLine): Array<{ time: UTCTimestamp; value: number }> {
    const data = [
      { time: this.toUtc(line.p1.time), value: line.p1.value },
      { time: this.toUtc(line.p2.time), value: line.p2.value },
    ];
    if (!line.rayRight) return data;
    const endTime = Math.max(line.p2.time + this.timeframeSeconds * 15, line.p1.time + 1);
    const dt = line.p2.time - line.p1.time;
    const endValue = dt === 0 ? line.p2.value : line.p2.value + ((line.p2.value - line.p1.value) / dt) * (endTime - line.p2.time);
    data.push({ time: this.toUtc(endTime), value: endValue });
    return data;
  }

  private buildBaselineData(startTime: number, endTime: number, value: number, tfSeconds: number): Array<{ time: UTCTimestamp; value: number }> {
    const points: Array<{ time: UTCTimestamp; value: number }> = [{ time: this.toUtc(startTime), value }];
    if (endTime > startTime + tfSeconds) {
      let cursor = Math.floor(startTime / tfSeconds) * tfSeconds + tfSeconds;
      while (cursor < endTime) {
        if (cursor > startTime) points.push({ time: this.toUtc(cursor), value });
        cursor += tfSeconds;
      }
    }
    points.push({ time: this.toUtc(endTime), value });
    return points;
  }

  private getTradeLevelsEndTime(tfSeconds: number): number {
    const lastCandleTime = this.candles[this.candles.length - 1]?.time ?? Math.floor(Date.now() / 1000);
    return lastCandleTime + tfSeconds * 15;
  }

  private formatAxisDate(time: unknown): string {
    return this.formatChartDate(time, false);
  }

  private formatHoverDate(time: unknown): string {
    return this.formatChartDate(time, true);
  }

  private formatChartDate(time: unknown, includeYear: boolean): string {
    const epochSeconds = this.extractChartEpochSeconds(time);
    if (epochSeconds === null) return "";
    const date = new Date(epochSeconds * 1000);
    const day = `${date.getUTCDate()}`.padStart(2, "0");
    const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
    if (!includeYear) return `${day}.${month}`;
    return `${day}.${month}.${date.getUTCFullYear()}`;
  }

  private extractChartEpochSeconds(time: unknown): number | null {
    if (typeof time === "number" || typeof time === "string") {
      const value = Number(time);
      return Number.isFinite(value) ? Number(this.toUtc(value)) : null;
    }
    if (time && typeof time === "object") {
      const year = Number((time as { year?: number }).year);
      const month = Number((time as { month?: number }).month);
      const day = Number((time as { day?: number }).day);
      if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
        return Math.floor(Date.UTC(year, month - 1, day) / 1000);
      }
    }
    return null;
  }

  private applyPriceFormat(): void {
    if (!this.priceSeries) return;
    const values = this.candles.flatMap((c) => [c.open, c.high, c.low, c.close]);
    const entry = this.parsePrice(this.entryPrice);
    const target = this.parsePrice(this.takeProfit);
    const stop = this.parsePrice(this.stopOrder);
    if (entry !== null) values.push(entry);
    if (target !== null) values.push(target);
    if (stop !== null) values.push(stop);
    const precision = this.inferPrecision(values);
    this.priceSeries.applyOptions({ priceFormat: { type: "price", precision, minMove: precision > 0 ? 1 / Math.pow(10, precision) : 1 } });
  }

  private inferPrecision(values: number[]): number {
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

  private getPriceMinMove(): number {
    const precision = this.inferPrecision(this.candles.flatMap((c) => [c.open, c.high, c.low, c.close]));
    return precision > 0 ? 1 / Math.pow(10, precision) : 1;
  }

  private filterIncomingCandlesForSeededHistory(incoming: Candle[]): Candle[] {
    return !this.seededFromChartData || this.seededHistoryEndTime === null ? incoming : incoming.filter((candle) => this.shouldAcceptIncomingCandle(candle));
  }

  private shouldAcceptIncomingCandle(candle: Candle): boolean {
    if (!this.seededFromChartData || this.seededHistoryEndTime === null) return true;
    const overlapSeconds = Math.max(this.timeframeSeconds * 2, 1);
    return candle.time >= this.seededHistoryEndTime - overlapSeconds;
  }

  private captureIndicatorWarmup(snapshot: Candle[]): void {
    if (!this.seededFromChartData || !this.articleSeedCandles.length) {
      this.indicatorWarmupCandles = [];
      return;
    }
    const visibleStartTime = this.articleSeedCandles[0].time;
    const warmupSlice = snapshot.filter((candle) => candle.time < visibleStartTime);
    if (!warmupSlice.length) return;
    const mergedWarmup = this.mergeCandles(this.indicatorWarmupCandles, warmupSlice);
    this.indicatorWarmupCandles = mergedWarmup.slice(-this.indicatorWarmupLimit);
  }

  private getIndicatorInputCandles(): Candle[] {
    return this.indicatorWarmupCandles.length ? this.mergeCandles(this.indicatorWarmupCandles, this.candles) : this.candles;
  }

  private filterIndicatorSeriesToVisibleRange<T extends { time: number }>(series: T[]): T[] {
    if (!series.length || !this.candles.length) return series;
    const visibleStartTime = this.candles[0].time;
    return series.filter((point) => point.time >= visibleStartTime);
  }

  private updateLastTfCandle(previous: Candle[], oneSecond: Candle, timeframeSeconds: number): Candle[] {
    const bucketStart = Math.floor(oneSecond.time / timeframeSeconds) * timeframeSeconds;
    if (!previous.length) return [{ time: bucketStart, open: oneSecond.open, high: oneSecond.high, low: oneSecond.low, close: oneSecond.close, volume: oneSecond.volume || 0 }];
    const last = previous[previous.length - 1];
    if (last.time === bucketStart) {
      const next = [...previous];
      next[next.length - 1] = { ...last, high: Math.max(last.high, oneSecond.high), low: Math.min(last.low, oneSecond.low), close: oneSecond.close, volume: (last.volume || 0) + (oneSecond.volume || 0) };
      return next;
    }
    if (bucketStart > last.time) return [...previous, { time: bucketStart, open: oneSecond.open, high: oneSecond.high, low: oneSecond.low, close: oneSecond.close, volume: oneSecond.volume || 0 }];
    return previous;
  }

  private upsertTfCandle(previous: Candle[], nextCandle: Candle): Candle[] {
    if (!previous.length) return [nextCandle];
    const next = [...previous];
    const index = next.findIndex((c) => c.time === nextCandle.time);
    if (index >= 0) next[index] = nextCandle;
    else if (nextCandle.time > next[next.length - 1].time) next.push(nextCandle);
    return next;
  }

  private mergeCandles(previous: Candle[], incoming: Candle[]): Candle[] {
    if (!previous.length) return [...incoming].sort((left, right) => left.time - right.time);
    const byTime = new Map<number, Candle>();
    for (const candle of previous) byTime.set(candle.time, candle);
    for (const candle of incoming) byTime.set(candle.time, candle);
    return Array.from(byTime.values()).sort((left, right) => left.time - right.time);
  }

  private async requestTfSnapshot(connection: signalR.HubConnection, source: string, count: number): Promise<void> {
    if (!this.currentSymbol || !this.hubTimeframe || !source || connection.state !== signalR.HubConnectionState.Connected) return;
    await connection.invoke("RequestCandlesSnapshot", this.currentSymbol, this.hubTimeframe, source, count);
  }

  private startTfSnapshotRefresh(connection: signalR.HubConnection, source: string): void {
    this.stopTfSnapshotRefresh();
    if (!this.currentSymbol || !this.hubTimeframe || !source || !this.isBrowser) return;
    this.tfSnapshotRefreshTimer = setInterval(() => {
      if (!this.connection || this.connection !== connection || connection.state !== signalR.HubConnectionState.Connected) return;
      void this.requestTfSnapshot(connection, source, this.refreshTfSnapshotCount).catch((error: unknown) => console.warn("Failed to refresh divergence tf snapshot", error));
    }, 5000);
  }

  private stopTfSnapshotRefresh(): void {
    if (this.tfSnapshotRefreshTimer !== null) clearInterval(this.tfSnapshotRefreshTimer);
    this.tfSnapshotRefreshTimer = null;
  }

  private removeTrendlines(): void {
    if (!this.chartRef) {
      this.overlayLineSeries = [];
      return;
    }
    for (const series of this.overlayLineSeries) {
      try { this.chartRef.removeSeries(series); } catch (error) { console.warn("Failed to remove divergence trendline", error); }
    }
    this.overlayLineSeries = [];
  }

  private removeTradeLevels(): void {
    if (this.chartRef) {
      for (const series of this.tradeLevelAreaSeries) {
        try { this.chartRef.removeSeries(series); } catch (error) { console.warn("Failed to remove divergence trade level area", error); }
      }
    }
    this.tradeLevelAreaSeries = [];
    for (const binding of this.priceLines) {
      try { (binding.series as any).removePriceLine(binding.line); } catch (error) { console.warn("Failed to remove divergence price line", error); }
    }
    this.priceLines = [];
  }

  private removeGuideLines(): void {
    for (const binding of this.guideLines) {
      try { (binding.series as any).removePriceLine(binding.line); } catch (error) { console.warn("Failed to remove divergence guide line", error); }
    }
    this.guideLines = [];
  }

  private destroyChart(): void {
    if (!this.chartRef) return;
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

  private parsePrice(value: string | null): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  private readNumber(source: any, keys: string[]): number | null {
    for (const key of keys) {
      const value = source?.[key];
      if (value === null || value === undefined || value === "") continue;
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
    return null;
  }

  private readOptionalNumber(source: any, keys: string[]): number | undefined {
    const value = this.readNumber(source, keys);
    return value === null ? undefined : value;
  }

  private toUtc(timestamp: number | string): UTCTimestamp {
    const value = typeof timestamp === "string" ? Number(timestamp) : timestamp;
    const seconds = value > 1e12 ? Math.floor(value / 1000) : Math.floor(value || 0);
    return seconds as UTCTimestamp;
  }

  private normalizeSymbol(value: string): string {
    return (value || "").trim().toUpperCase();
  }

  private normalizeSource(value: string): string {
    const normalized = (value || "").trim().toLowerCase();
    return normalized === "ohlc" || normalized === "quotes" ? normalized : "";
  }

  private normalizeDisplayTimeframe(value: string): string {
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

  private toHubTimeframe(displayTimeframe: string): string {
    const map: Record<string, string> = { M1: "1m", M5: "5m", M15: "15m", M30: "30m", M60: "1h", M240: "4h", M1440: "1d", M10080: "1w", M43200: "1M", H1: "1h", H4: "4h", D1: "1d", W1: "1w", MN1: "1M", Y1: "1y" };
    return map[displayTimeframe] || displayTimeframe;
  }

  private timeframeToSeconds(displayTimeframe: string): number {
    const value = displayTimeframe.toUpperCase().trim();
    if (value === "MN1") return 30 * 86400;
    if (value === "W1") return 7 * 86400;
    if (value === "Y1") return 365 * 86400;
    if (value.startsWith("M")) return Number(value.replace("M", "")) * 60;
    if (value.startsWith("H")) return Number(value.replace("H", "")) * 3600;
    if (value.startsWith("D")) return Number(value.replace("D", "")) * 86400;
    return 300;
  }

  private stringifyError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
