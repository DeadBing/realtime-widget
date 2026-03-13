import {
  AfterViewInit,
  Component,
  ElementRef,
  inject,
  Input,
  OnChanges,
  OnDestroy,
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

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

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
  @Input() symbol = "";
  @Input() timeframe = "M15";
  @Input() source = "ohlc";
  @Input() active = false;
  @Input() height = 500;
  @Input() initialCandles: any[] | null = null;
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
  private hubTimeframe = "";
  private timeframeSeconds = 60;
  private currentKey = "";
  private syncToken = 0;
  private viewInitialized = false;
  private autoFitApplied = false;
  private lastTrendlineAnchorTime: number | null = null;
  private tradeLevelPriceLines: Array<{ series: ISeriesApi<"Candlestick">; line: any }> = [];
  private tfSnapshotRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private seededHistoryEndTime: number | null = null;
  private readonly initialTfSnapshotCount = 100;
  private readonly refreshTfSnapshotCount = 5;

  private quotesHubConnectionService = inject(QuotesHubConnectionService);

  private get hubTimeOffsetSeconds(): number {
    return Math.trunc((Number(this.hubTimeOffsetHours) || 0) * 60 * 60);
  }

  constructor() {}

  ngAfterViewInit(): void {
    this.viewInitialized = true;
    if (!this.isBrowser) {
      return;
    }

    this.createChart();
    this.seedInitialCandles();
    this.renderTrendlines();
    void this.syncRealtime();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.viewInitialized || !this.isBrowser) {
      return;
    }

    if (changes["height"] && this.chartRef) {
      this.chartRef.applyOptions({ height: this.height });
    }

    if (changes["initialCandles"]) {
      this.seedInitialCandles();
    }

    if (changes["objects"]) {
      this.renderTrendlines();
    }

    if (
      changes["entryPrice"] ||
      changes["takeProfit"] ||
      changes["stopOrder"]
    ) {
      this.renderTradeLevels();
    }

    if (
      changes["symbol"] ||
      changes["timeframe"] ||
      changes["source"] ||
      changes["active"]
    ) {
      void this.syncRealtime();
    }
  }

  ngOnDestroy(): void {
    void this.teardownRealtime();
    this.removeTrendlines();
    this.removeTradeLevels();
    this.destroyChart();
  }

  private async syncRealtime(): Promise<void> {
    const token = ++this.syncToken;

    const normalizedSymbol = this.normalizeSymbol(this.symbol);
    const normalizedDisplayTimeframe = this.normalizeDisplayTimeframe(
      this.timeframe,
    );
    const normalizedSource = this.normalizeSource(this.source);

    if (
      !this.active ||
      !normalizedSymbol ||
      !normalizedDisplayTimeframe ||
      !normalizedSource
    ) {
      await this.teardownRealtime();
      if (token !== this.syncToken) {
        return;
      }

      this.loading = false;
      this.connected = false;
      this.error = null;
      return;
    }

    const nextKey = `${normalizedSymbol}|${normalizedDisplayTimeframe}|${normalizedSource}`;
    if (this.currentKey === nextKey && this.connection && this.candleEventHandler) {
      return;
    }

    await this.teardownRealtime();
    if (token !== this.syncToken) {
      return;
    }

    this.loading = !this.seededFromChartData;
    this.error = null;

    if (!this.seededFromChartData) {
      this.candles = [];
      this.autoFitApplied = false;
      this.renderCandles();
    }

    try {
      const connection = await this.quotesHubConnectionService.ensureConnected();
      if (token !== this.syncToken) {
        return;
      }

      this.connection = connection;
      this.connected =
        connection.state === signalR.HubConnectionState.Connected;
      this.currentSymbol = normalizedSymbol;
      this.displayTimeframe = normalizedDisplayTimeframe;
      this.hubTimeframe = this.toHubTimeframe(normalizedDisplayTimeframe);
      this.timeframeSeconds = this.timeframeToSeconds(
        normalizedDisplayTimeframe,
      );
      this.currentKey = nextKey;

      this.candleEventHandler = (evt: any) => this.handleCandleEvent(evt);
      connection.on("candle_event", this.candleEventHandler);

      let anySubscribed = false;

      try {
        await connection.invoke(
          "SubscribeCandles",
          this.currentSymbol,
          this.hubTimeframe ?? "1m",
          normalizedSource,
        );
        anySubscribed = true;
      } catch (tfError) {
        console.warn("TF subscribe failed, trying 1s only", tfError);
      }

      if (this.shouldUseOneSecondAggregation(normalizedSource)) {
        try {
          await connection.invoke(
            "SubscribeCandles",
            this.currentSymbol,
            "1s",
            normalizedSource,
          );
          anySubscribed = true;
        } catch (secError) {
          console.warn("1s subscribe failed", secError);
        }
      } else {
        await this.requestTfSnapshot(
          connection,
          normalizedSource,
          this.initialTfSnapshotCount,
        );
        if (token !== this.syncToken) {
          return;
        }
        this.startTfSnapshotRefresh(connection, normalizedSource);
      }

      if (!anySubscribed && !this.seededFromChartData) {
        throw new Error("No realtime subscription succeeded");
      }
    } catch (error) {
      console.error("Failed to initialize realtime chart", error);
      if (!this.seededFromChartData) {
        this.error = this.stringifyError(error);
      }
      this.connected = false;
    } finally {
      if (token === this.syncToken) {
        this.loading = false;
      }
    }
  }

  private handleCandleEvent(evt: any): void {
    if (!evt || evt.symbol !== this.currentSymbol) {
      return;
    }

    const evtSource = this.normalizeSource(evt.source || "");
    const expectedSource = this.normalizeSource(this.source);
    if (evtSource && evtSource !== expectedSource) {
      return;
    }

    if (
      evt.type === "candle" &&
      evt.eventType === "snapshot" &&
      evt.tf === this.hubTimeframe
    ) {
      const snapshot = (evt.candles || [])
        .map((candle: any) => this.normalizeTfCandle(candle, this.hubTimeOffsetSeconds))
        .filter((candle: Candle | null): candle is Candle => !!candle)
        .sort((left: Candle, right: Candle) => left.time - right.time);

      if (!snapshot.length) {
        return;
      }

      const filteredSnapshot = this.filterIncomingCandlesForSeededHistory(snapshot);
      if (!filteredSnapshot.length) {
        return;
      }

      if (this.candles.length) {
        this.candles = this.mergeCandles(this.candles, filteredSnapshot);
      } else {
        this.candles = filteredSnapshot;
      }

      this.renderCandles();
      return;
    }

    if (
      evt.type === "candle" &&
      (evt.eventType === "candle_close" || evt.eventType === "candle_update") &&
      evt.tf === "1s"
    ) {
      const oneSecondCandle = this.normalizeCandle(evt.candle, this.hubTimeOffsetSeconds);
      if (!oneSecondCandle) {
        return;
      }

      this.candles = this.updateLastTfCandle(
        this.candles,
        oneSecondCandle,
        this.timeframeSeconds,
      );
      this.renderLastCandle();
      return;
    }

    if (
      evt.type === "candle" &&
      (evt.eventType === "candle_close" || evt.eventType === "candle_update") &&
      evt.tf === this.hubTimeframe
    ) {
      const tfCandle = this.normalizeTfCandle(evt.candle, this.hubTimeOffsetSeconds);
      if (!tfCandle) {
        return;
      }

      if (!this.shouldAcceptIncomingCandle(tfCandle)) {
        return;
      }

      this.candles = this.upsertTfCandle(this.candles, tfCandle);
      this.renderLastCandle();
    }
  }

  private async teardownRealtime(): Promise<void> {
    this.stopTfSnapshotRefresh();

    if (!this.connection) {
      this.candleEventHandler = null;
      this.currentKey = "";
      this.lastTrendlineAnchorTime = null;
      return;
    }

    const connection = this.connection;
    const currentSource = this.normalizeSource(this.source);

    if (this.candleEventHandler) {
      connection.off("candle_event", this.candleEventHandler);
      this.candleEventHandler = null;
    }

    if (
      this.currentSymbol &&
      this.hubTimeframe &&
      currentSource &&
      connection.state === signalR.HubConnectionState.Connected
    ) {
      try {
        await connection.invoke(
          "UnsubscribeCandles",
          this.currentSymbol,
          this.hubTimeframe,
          currentSource,
        );
      } catch (error) {
        console.error("Failed to unsubscribe from tf candles", error);
      }

      try {
        if (this.shouldUseOneSecondAggregation(currentSource)) {
          await connection.invoke(
            "UnsubscribeCandles",
            this.currentSymbol,
            "1s",
            currentSource,
          );
        }
      } catch (error) {
        console.error("Failed to unsubscribe from 1s candles", error);
      }
    }

    this.connection = null;
    this.currentSymbol = "";
    this.displayTimeframe = "";
    this.hubTimeframe = "";
    this.currentKey = "";
    this.timeframeSeconds = 60;
    this.lastTrendlineAnchorTime = null;
  }

  private createChart(): void {
    if (!this.chartContainerRef?.nativeElement) {
      return;
    }

    const chart = createChart(this.chartContainerRef.nativeElement, {
      autoSize: true,
      height: this.height,
      rightPriceScale: {
        visible: true,
        borderVisible: false,
        scaleMargins: {
          top: 0.06,
          bottom: 0.06,
        },
      },
      leftPriceScale: { visible: false },
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#374151",
      },
      grid: {
        vertLines: { visible: true, color: "rgba(0, 0, 0, 0.08)" },
        horzLines: { visible: true, color: "rgba(0, 0, 0, 0.08)" },
      },
      timeScale: {
        rightBarStaysOnScroll: true,
        barSpacing: 14,
        rightOffset: 5,
      },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      lastValueVisible: true,
      priceLineVisible: false,
      priceFormat: {
        type: "price",
        precision: 5,
        minMove: 0.00001,
      },
    });

    this.chartRef = chart;
    this.candlesRef = candles;
  }

  private destroyChart(): void {
    if (!this.chartRef) {
      return;
    }

    this.chartRef.remove();
    this.chartRef = null;
    this.candlesRef = null;
    this.lineSeries = [];
    this.baselineSeries = [];
    this.tradeLevelPriceLines = [];
  }

  private renderCandles(): void {
    if (!this.chartRef || !this.candlesRef) {
      return;
    }

    const data = this.candles
      .map((candle) => ({
        time: this.toUtc(candle.time),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      }))
      .sort((left, right) => Number(left.time) - Number(right.time));

    this.candlesRef.setData(data);
    this.renderTrendlines();
    this.lastTrendlineAnchorTime = this.candles.length
      ? this.candles[this.candles.length - 1].time
      : null;
    if (!data.length || this.autoFitApplied) {
      return;
    }

    this.chartRef.timeScale().fitContent();
    this.autoFitApplied = true;

    requestAnimationFrame(() => {
      this.chartRef?.timeScale().scrollToRealTime();
    });
  }

  private renderLastCandle(): void {
    if (!this.candlesRef || !this.candles.length) {
      return;
    }

    const last = this.candles[this.candles.length - 1];
    try {
      this.candlesRef.update({
        time: this.toUtc(last.time),
        open: last.open,
        high: last.high,
        low: last.low,
        close: last.close,
      });
    } catch (err) {
      const data = this.candles
        .map((candle) => ({
          time: this.toUtc(candle.time),
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        }))
        .sort((left, right) => Number(left.time) - Number(right.time));
      this.candlesRef.setData(data);
    }

    if (
      this.lastTrendlineAnchorTime === null ||
      this.lastTrendlineAnchorTime !== last.time
    ) {
      this.lastTrendlineAnchorTime = last.time;
      this.renderTrendlines();
    }
  }

  private toUtc(timestamp: number | string): UTCTimestamp {
    const value = typeof timestamp === "string" ? Number(timestamp) : timestamp;
    const seconds =
      value > 1e12 ? Math.floor(value / 1000) : Math.floor(value || 0);
    return seconds as UTCTimestamp;
  }

  private normalizeCandle(candle: any, timeOffsetSeconds = 0): Candle | null {
    if (!candle) {
      return null;
    }

    const time = this.readCandleValue(candle, ["time", "Time", "t", "T"]);
    const open = this.readCandleValue(candle, ["open", "Open", "o", "O"]);
    const high = this.readCandleValue(candle, ["high", "High", "h", "H"]);
    const low = this.readCandleValue(candle, ["low", "Low", "l", "L"]);
    const close = this.readCandleValue(candle, ["close", "Close", "c", "C"]);
    const volume = this.readOptionalCandleValue(candle, [
      "volume",
      "Volume",
      "v",
      "V",
    ]);

    if (
      time === null ||
      open === null ||
      high === null ||
      low === null ||
      close === null
    ) {
      return null;
    }

    return {
      time: Number(this.toUtc(time)) + timeOffsetSeconds,
      open,
      high,
      low,
      close,
      volume,
    };
  }

  private normalizeTfCandle(candle: any, timeOffsetSeconds = 0): Candle | null {
    const normalized = this.normalizeCandle(candle, timeOffsetSeconds);
    if (!normalized) {
      return null;
    }

    return {
      ...normalized,
      time: this.normalizeTfTimestamp(normalized.time),
    };
  }

  private normalizeTfTimestamp(rawTime: number): number {
    const raw = Number(this.toUtc(rawTime));
    if (!Number.isFinite(raw) || raw <= 0) {
      return 0;
    }

    const tfSec = Math.max(1, this.timeframeSeconds || 60);
    const bucketStart = Math.floor(raw / tfSec) * tfSec;
    const lastLocalTime = this.candles.length
      ? this.candles[this.candles.length - 1].time
      : null;

    if (raw % tfSec === 0 && lastLocalTime !== null && lastLocalTime === raw - tfSec) {
      return raw - tfSec;
    }

    return bucketStart;
  }

  private filterIncomingCandlesForSeededHistory(incoming: Candle[]): Candle[] {
    if (!this.seededFromChartData || this.seededHistoryEndTime === null) {
      return incoming;
    }

    return incoming.filter((candle) => this.shouldAcceptIncomingCandle(candle));
  }

  private shouldAcceptIncomingCandle(candle: Candle): boolean {
    if (!this.seededFromChartData || this.seededHistoryEndTime === null) {
      return true;
    }

    return candle.time > this.seededHistoryEndTime;
  }

  private updateLastTfCandle(
    previous: Candle[],
    oneSecondCandle: Candle,
    timeframeSeconds: number,
  ): Candle[] {
    if (!previous.length) {
      return previous;
    }

    const bucketStart =
      Math.floor(oneSecondCandle.time / timeframeSeconds) * timeframeSeconds;
    const last = previous[previous.length - 1];

    if (last.time === bucketStart) {
      const next = [...previous];
      next[next.length - 1] = {
        ...last,
        high: Math.max(last.high, oneSecondCandle.high),
        low: Math.min(last.low, oneSecondCandle.low),
        close: oneSecondCandle.close,
        volume: (last.volume || 0) + (oneSecondCandle.volume || 0),
      };
      return next;
    }

    if (bucketStart > last.time) {
      return [
        ...previous,
        {
          time: bucketStart,
          open: oneSecondCandle.open,
          high: oneSecondCandle.high,
          low: oneSecondCandle.low,
          close: oneSecondCandle.close,
          volume: oneSecondCandle.volume || 0,
        },
      ];
    }

    return previous;
  }

  private upsertTfCandle(previous: Candle[], nextCandle: Candle): Candle[] {
    if (!previous.length) {
      return [nextCandle];
    }

    const next = [...previous];
    const idx = next.findIndex((candle) => candle.time === nextCandle.time);
    if (idx >= 0) {
      next[idx] = nextCandle;
      return next;
    }

    const last = next[next.length - 1];
    if (nextCandle.time > last.time) {
      next.push(nextCandle);
      return next;
    }

    return next;
  }

  private mergeCandles(previous: Candle[], incoming: Candle[]): Candle[] {
    if (!previous.length) {
      return [...incoming].sort((a, b) => a.time - b.time);
    }

    const mergedByTime = new Map<number, Candle>();
    for (const candle of previous) {
      mergedByTime.set(candle.time, candle);
    }
    for (const candle of incoming) {
      mergedByTime.set(candle.time, candle);
    }

    return Array.from(mergedByTime.values()).sort((a, b) => a.time - b.time);
  }

  private shouldUseOneSecondAggregation(normalizedSource: string): boolean {
    return normalizedSource === "quotes";
  }

  private async requestTfSnapshot(
    connection: signalR.HubConnection,
    normalizedSource: string,
    count: number,
  ): Promise<void> {
    if (
      !this.currentSymbol ||
      !this.hubTimeframe ||
      !normalizedSource ||
      connection.state !== signalR.HubConnectionState.Connected
    ) {
      return;
    }

    await connection.invoke(
      "RequestCandlesSnapshot",
      this.currentSymbol,
      this.hubTimeframe,
      normalizedSource,
      count,
    );
  }

  private startTfSnapshotRefresh(
    connection: signalR.HubConnection,
    normalizedSource: string,
  ): void {
    this.stopTfSnapshotRefresh();

    if (
      !this.isBrowser ||
      !this.currentSymbol ||
      !this.hubTimeframe ||
      !normalizedSource
    ) {
      return;
    }

    this.tfSnapshotRefreshTimer = setInterval(() => {
      if (
        !this.connection ||
        this.connection !== connection ||
        connection.state !== signalR.HubConnectionState.Connected
      ) {
        return;
      }

      void this.requestTfSnapshot(
        connection,
        normalizedSource,
        this.refreshTfSnapshotCount,
      ).catch((error: unknown) => {
        console.warn("Failed to refresh tf snapshot", error);
      });
    }, 5000);
  }

  private stopTfSnapshotRefresh(): void {
    if (this.tfSnapshotRefreshTimer !== null) {
      clearInterval(this.tfSnapshotRefreshTimer);
      this.tfSnapshotRefreshTimer = null;
    }
  }

  private readCandleValue(
    candle: any,
    keys: string[],
  ): number | null {
    for (const key of keys) {
      const value = candle?.[key];
      if (value === null || value === undefined || value === "") {
        continue;
      }

      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
    }

    return null;
  }

  private readOptionalCandleValue(
    candle: any,
    keys: string[],
  ): number | undefined {
    const value = this.readCandleValue(candle, keys);
    return value === null ? undefined : Number(value);
  }

  private seedInitialCandles(): void {
    if (!this.initialCandles?.length || !this.candlesRef || !this.chartRef) {
      return;
    }

    const seeded = this.initialCandles
      .map((c: any) => this.normalizeCandle(c))
      .filter((c: Candle | null): c is Candle => !!c)
      .sort((a, b) => a.time - b.time);

    if (!seeded.length) {
      return;
    }

    this.candles = seeded;
    this.seededFromChartData = true;
    this.seededHistoryEndTime = seeded[seeded.length - 1].time;
    this.renderCandles();
  }

  private removeTrendlines(): void {
    if (!this.chartRef) {
      this.lineSeries = [];
      return;
    }

    for (const series of this.lineSeries) {
      try {
        this.chartRef.removeSeries(series);
      } catch (error) {
        console.warn("Failed to remove trendline series", error);
      }
    }
    this.lineSeries = [];
  }

  private removeTradeLevels(): void {
    if (this.candlesRef) {
      for (const entry of this.tradeLevelPriceLines) {
        try {
          entry.series.removePriceLine(entry.line);
        } catch (error) {
          console.warn("Failed to remove trade level price line", error);
        }
      }
    }
    this.tradeLevelPriceLines = [];

    if (!this.chartRef) {
      this.baselineSeries = [];
      return;
    }

    for (const series of this.baselineSeries) {
      try {
        this.chartRef.removeSeries(series);
      } catch (error) {
        console.warn("Failed to remove trade level series", error);
      }
    }
    this.baselineSeries = [];
  }

  private renderTrendlines(): void {
    if (!this.chartRef) {
      return;
    }

    this.removeTrendlines();

    const objects = this.objects;
    if (!objects?.length) {
      this.renderTradeLevels();
      return;
    }

    const tfSec = this.timeframeToSeconds(
      this.normalizeDisplayTimeframe(this.timeframe),
    );
    const normalizedLines: Array<{
      id: number;
      style: string;
      rayRight: boolean;
      color: string;
      width: number;
      p1: { time: UTCTimestamp; value: number };
      p2: { time: UTCTimestamp; value: number };
      k?: number;
      b?: number;
      intersectTime?: number;
      intersectValue?: number;
    }> = [];

    for (const obj of objects) {
      if (obj?.type !== "trendline") {
        continue;
      }

      const rawPoints = obj?.points;
      if (!Array.isArray(rawPoints) || rawPoints.length < 2) {
        continue;
      }

      const points = rawPoints
        .map((p: any) => ({
          time: this.toUtc(Number(p?.time)),
          value: Number(p?.price),
        }))
        .filter(
          (p: { time: UTCTimestamp; value: number }) =>
            Number(p.time) > 0 && Number.isFinite(p.value),
        )
        .sort(
          (a: { time: UTCTimestamp }, b: { time: UTCTimestamp }) =>
            Number(a.time) - Number(b.time),
        );

      if (points.length < 2) {
        continue;
      }

      let p1 = points[0];
      let p2 = points[points.length - 1];
      if (Number(p1.time) > Number(p2.time)) {
        [p1, p2] = [p2, p1];
      }

      const dt = Number(p2.time) - Number(p1.time);
      let k = undefined;
      let b = undefined;
      if (dt !== 0) {
        k = (p2.value - p1.value) / dt;
        b = p1.value - k * Number(p1.time);
      }

      normalizedLines.push({
        id: Number(obj?.id) || 0,
        style: String(obj?.style ?? "solid").toLowerCase(),
        rayRight: !!obj?.ray_right,
        color: String(obj?.color ?? "#999999"),
        width: Number(obj?.width ?? 2),
        p1,
        p2,
        k,
        b,
      });
    }

    let globalIntersectTime: number | null = null;
    for (const l1 of normalizedLines) {
      if (!l1.rayRight || l1.k === undefined || l1.style === "dot") continue;

      let earliestIntersectTime = Infinity;
      let intersectVal = undefined;

      for (const l2 of normalizedLines) {
        if (l1 === l2) continue;
        if (!l2.rayRight || l2.k === undefined || l2.style === "dot") continue;

        if (Math.abs(l1.k - l2.k) < 1e-12) continue;

        const x = (l2.b! - l1.b!) / (l1.k - l2.k);
        const minX1 = Number(l1.p1.time);
        const minX2 = Number(l2.p1.time);

        if (x > minX1 && x > minX2) {
          if (x < earliestIntersectTime) {
            earliestIntersectTime = x;
            intersectVal = l1.k * x + l1.b!;
          }
        }
      }

      if (earliestIntersectTime !== Infinity) {
        l1.intersectTime = earliestIntersectTime;
        l1.intersectValue = intersectVal;
        if (globalIntersectTime === null || earliestIntersectTime < globalIntersectTime) {
          globalIntersectTime = earliestIntersectTime;
        }
      }
    }

    for (const line of normalizedLines) {
      const lineWidth = Math.min(Math.max(Number(line.width || 2), 1), 4) as
        | 1
        | 2
        | 3
        | 4;

      const series = this.chartRef.addSeries(LineSeries, {
        color: line.color,
        lineWidth,
        lineStyle: line.style === "dot" ? LineStyle.Dotted : LineStyle.Solid,
        priceScaleId: "right",
        lastValueVisible: false,
        priceLineVisible: false,
        pointMarkersVisible: false,
        autoscaleInfoProvider: () => null,
      });

      if (line.rayRight) {
        const linePoints = this.buildLineData(
          { time: Number(line.p1.time), value: line.p1.value },
          { time: Number(line.p2.time), value: line.p2.value },
          line.intersectTime,
          line.intersectValue,
          tfSec
        );
        series.setData(linePoints);
      } else {
        series.setData([
          { time: line.p1.time, value: line.p1.value },
          { time: line.p2.time, value: line.p2.value },
        ]);
      }

      this.lineSeries.push(series);
    }

    this.renderTradeLevels();
  }

  private renderTradeLevels(): void {
    if (!this.chartRef || !this.candlesRef) {
      return;
    }

    this.removeTradeLevels();

    const entry = this.parseTradeLevel(this.entryPrice);
    const target = this.parseTradeLevel(this.takeProfit);
    const stop = this.parseTradeLevel(this.stopOrder);

    if (entry === null && target === null && stop === null) {
      return;
    }

    const tfSec = this.timeframeToSeconds(
      this.normalizeDisplayTimeframe(this.timeframe),
    );
    const { startX, endX } = this.getTradeLevelsRange(tfSec);

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
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        priceScaleId: "right",
        lastValueVisible: false,
        priceLineVisible: false,
        pointMarkersVisible: false,
        baseLineVisible: false,
        autoscaleInfoProvider: () => null,
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
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        priceScaleId: "right",
        lastValueVisible: false,
        priceLineVisible: false,
        pointMarkersVisible: false,
        baseLineVisible: false,
        autoscaleInfoProvider: () => null,
      });
      slSeries.setData(this.buildBaselineData(startX, endX, stop, tfSec));
      this.baselineSeries.push(slSeries);
    }

    if (entry !== null) {
      const line = this.candlesRef.createPriceLine({
        price: entry,
        color: "#8b9098",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Entry",
        lineVisible: true,
      });
      this.tradeLevelPriceLines.push({ series: this.candlesRef, line });
    }

    if (stop !== null) {
      const line = this.candlesRef.createPriceLine({
        price: stop,
        color: "#ef5350",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Stop",
        lineVisible: true,
      });
      this.tradeLevelPriceLines.push({ series: this.candlesRef, line });
    }

    if (target !== null) {
      const line = this.candlesRef.createPriceLine({
        price: target,
        color: "#18a67d",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Target",
        lineVisible: true,
      });
      this.tradeLevelPriceLines.push({ series: this.candlesRef, line });
    }
  }

  private getTradeLevelsRange(tfSec: number): {
    startX: number;
    endX: number;
  } {
    let startX = Math.floor(Date.now() / 1000);
    const lastInitialCandle = this.initialCandles?.length
      ? this.initialCandles[this.initialCandles.length - 1]
      : null;
    const lastLiveCandle = this.candles.length
      ? this.candles[this.candles.length - 1]
      : null;

    if (lastInitialCandle) {
      startX = Number(this.toUtc(lastInitialCandle.time));
    } else if (lastLiveCandle) {
      startX = lastLiveCandle.time;
    }

    let endX = startX + tfSec * 15;
    const objects = Array.isArray(this.objects) ? this.objects : [];
    for (const object of objects) {
      if (object?.type !== "trendline" || String(object?.style ?? "").toLowerCase() !== "dot") {
        continue;
      }

      const rawPoints = Array.isArray(object?.points) ? object.points : [];
      for (const point of rawPoints) {
        const pointTime = Number(this.toUtc(Number(point?.time)));
        if (Number.isFinite(pointTime) && pointTime > endX) {
          endX = pointTime;
        }
      }
    }

    return { startX, endX };
  }

  private parseTradeLevel(value: string | null): number | null {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : null;
  }

  private buildLineData(
    p1: { time: number; value: number },
    p2: { time: number; value: number },
    iTime: number | undefined,
    iValue: number | undefined,
    tfSec: number
  ): Array<{ time: UTCTimestamp; value: number }> {
    const points: Array<{ time: UTCTimestamp; value: number }> = [];
    points.push({ time: p1.time as UTCTimestamp, value: p1.value });

    if (iTime !== undefined && iValue !== undefined) {
      if (iTime <= p1.time) {
        if (p2.time > p1.time) {
          points.push({ time: p2.time as UTCTimestamp, value: p2.value });
        }
      } else if (iTime <= p2.time) {
        points.push({ time: Math.round(iTime) as UTCTimestamp, value: iValue });
      } else {
        if (p2.time > p1.time) {
          points.push({ time: p2.time as UTCTimestamp, value: p2.value });
        }
        const dt = iTime - p2.time;
        if (dt > tfSec) {
          const slope = (iValue - p2.value) / dt;
          let t = Math.floor(p2.time / tfSec) * tfSec + tfSec;
          while (t < iTime) {
            if (t > p2.time) {
              const v = p2.value + slope * (t - p2.time);
              points.push({ time: Math.round(t) as UTCTimestamp, value: v });
            }
            t += tfSec;
          }
        }
        points.push({ time: Math.round(iTime) as UTCTimestamp, value: iValue });
      }
    } else {
      if (p2.time > p1.time) {
        points.push({ time: p2.time as UTCTimestamp, value: p2.value });
      }
      const dt = p2.time - p1.time;
      const endTime = Math.max(p1.time + 1, p2.time + tfSec * 15);
      if (dt === 0) {
        points.push({ time: endTime as UTCTimestamp, value: p2.value });
      } else {
        const slope = (p2.value - p1.value) / dt;
        const targetValue = p2.value + slope * (endTime - p2.time);
        let t = Math.floor(p2.time / tfSec) * tfSec + tfSec;
        while (t < endTime) {
          if (t > p2.time) {
            const v = p2.value + slope * (t - p2.time);
            points.push({ time: Math.round(t) as UTCTimestamp, value: v });
          }
          t += tfSec;
        }
        points.push({ time: Math.round(endTime) as UTCTimestamp, value: targetValue });
      }
    }

    return points;
  }

  private buildBaselineData(
    startX: number,
    endX: number,
    val: number,
    tfSec: number
  ): Array<{ time: UTCTimestamp; value: number }> {
    const points: Array<{ time: UTCTimestamp; value: number }> = [];
    points.push({ time: Math.round(startX) as UTCTimestamp, value: val });
    if (endX > startX + tfSec) {
      let t = Math.floor(startX / tfSec) * tfSec + tfSec;
      while (t < endX) {
        if (t > startX) {
          points.push({ time: Math.round(t) as UTCTimestamp, value: val });
        }
        t += tfSec;
      }
    }
    points.push({ time: Math.round(endX) as UTCTimestamp, value: val });
    return points;
  }

  private normalizeSymbol(value: string): string {
    return (value || "").trim().toUpperCase();
  }

  private normalizeSource(value: string): string {
    const normalized = (value || "").trim().toLowerCase();
    if (normalized === "ohlc" || normalized === "quotes") {
      return normalized;
    }

    return "";
  }

  private normalizeDisplayTimeframe(value: string): string {
    if (!value) {
      return "";
    }

    const prepared = value
      .trim()
      .replace(/\u041c/g, "M")
      .replace(/\u043c/g, "m");
    if (!prepared) {
      return "";
    }

    if (/^\d+$/.test(prepared)) {
      return `M${prepared}`;
    }

    const upper = prepared.toUpperCase();
    if (upper === "MN") {
      return "MN1";
    }
    if (/^M\d+$/.test(upper)) {
      const mins = Number(upper.replace("M", ""));
      if (mins === 60) return "H1";
      if (mins === 240) return "H4";
      if (mins === 1440) return "D1";
      if (mins === 10080) return "W1";
      if (mins === 43200) return "MN1";
      return upper;
    }
    if (/^H\d+$/.test(upper)) {
      return upper;
    }
    if (upper === "D1" || upper === "W1" || upper === "MN1" || upper === "Y1") {
      return upper;
    }
    if (/^\d+M$/.test(upper)) {
      return `M${upper.slice(0, -1)}`;
    }
    if (/^\d+H$/.test(upper)) {
      return `H${upper.slice(0, -1)}`;
    }
    if (upper === "1D") {
      return "D1";
    }
    if (upper === "1W") {
      return "W1";
    }
    if (upper === "1Y") {
      return "Y1";
    }

    return "";
  }

  private toHubTimeframe(displayTimeframe: string): string {
    const map: Record<string, string> = {
      M1: "1m",
      M5: "5m",
      M15: "15m",
      M30: "30m",
      M60: "1h",
      M240: "4h",
      M1440: "1d",
      M10080: "1w",
      M43200: "1M",
      H1: "1h",
      H4: "4h",
      D1: "1d",
      W1: "1w",
      MN1: "1M",
      Y1: "1y",
    };

    return map[displayTimeframe] || displayTimeframe;
  }

  private timeframeToSeconds(displayTimeframe: string): number {
    const value = displayTimeframe.toUpperCase().trim();
    if (value === "MN1") {
      return 30 * 86400;
    }
    if (value === "W1") {
      return 7 * 86400;
    }
    if (value === "Y1") {
      return 365 * 86400;
    }
    if (value.startsWith("M")) {
      return Number(value.replace("M", "")) * 60;
    }
    if (value.startsWith("H")) {
      return Number(value.replace("H", "")) * 3600;
    }
    if (value.startsWith("D")) {
      return Number(value.replace("D", "")) * 86400;
    }
    if (value.endsWith("M")) {
      return Number(value.replace("M", "")) * 60;
    }
    if (value.endsWith("H")) {
      return Number(value.replace("H", "")) * 3600;
    }

    return 60;
  }

  private stringifyError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
