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

type Candle = IndicatorCandle;

type NormalizedTrendLine = {
  color: string;
  width: 1 | 2 | 3 | 4;
  style: "solid" | "dot";
  rayRight: boolean;
  paneIndex: number;
  p1: { time: number; value: number };
  p2: { time: number; value: number };
};

type PriceLineBinding = {
  series:
    | ISeriesApi<"Candlestick">
    | ISeriesApi<"Line">
    | ISeriesApi<"Histogram">;
  line: unknown;
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
  @Input() height = 700;
  @Input() initialCandles: any[] | null = null;
  @Input() trendLines: any[] | null = null;
  @Input() objects: any[] | null = null;
  @Input() takeProfit: string | null = null;
  @Input() stopOrder: string | null = null;
  @Input() entryPrice: string | null = null;

  @ViewChild("chartContainer", { static: false })
  chartContainerRef!: ElementRef<HTMLDivElement>;

  error: string | null = null;

  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser: boolean = isPlatformBrowser(this.platformId);

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
  private priceLines: PriceLineBinding[] = [];
  private indicatorGuideLines: PriceLineBinding[] = [];
  private candles: Candle[] = [];
  private viewInitialized = false;
  private autoFitApplied = false;

  ngAfterViewInit(): void {
    this.viewInitialized = true;
    if (!this.isBrowser) {
      return;
    }

    this.createChart();
    this.refreshChart();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.viewInitialized || !this.isBrowser) {
      return;
    }

    if (changes["height"] && this.chartRef) {
      this.chartRef.applyOptions({ height: this.height });
    }

    if (
      changes["timeframe"] ||
      changes["initialCandles"] ||
      changes["trendLines"] ||
      changes["objects"] ||
      changes["entryPrice"] ||
      changes["takeProfit"] ||
      changes["stopOrder"]
    ) {
      this.refreshChart();
    }
  }

  ngOnDestroy(): void {
    this.removeTrendlines();
    this.removeTradeLevels();
    this.removeIndicatorGuideLines();
    this.destroyChart();
  }

  private createChart(): void {
    if (!this.chartContainerRef?.nativeElement) {
      return;
    }

    const chart = createChart(this.chartContainerRef.nativeElement, {
      autoSize: true,
      height: this.height,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#111827",
      },
      grid: {
        vertLines: { visible: true, color: "rgba(17, 24, 39, 0.08)" },
        horzLines: { visible: true, color: "rgba(17, 24, 39, 0.08)" },
      },
      rightPriceScale: {
        visible: true,
        borderVisible: false,
        scaleMargins: {
          top: 0.06,
          bottom: 0.06,
        },
      },
      leftPriceScale: { visible: false },
      timeScale: {
        rightBarStaysOnScroll: true,
        barSpacing: 10,
        rightOffset: 3,
        borderVisible: false,
      },
      crosshair: {
        vertLine: {
          width: 1,
          color: "rgba(17, 24, 39, 0.25)",
        },
        horzLine: {
          width: 1,
          color: "rgba(17, 24, 39, 0.25)",
        },
      },
    });

    while (chart.panes().length < 4) {
      chart.addPane(true);
    }

    chart.panes()[0]?.setStretchFactor(6);
    chart.panes()[1]?.setStretchFactor(2);
    chart.panes()[2]?.setStretchFactor(2);
    chart.panes()[3]?.setStretchFactor(2.5);

    this.priceSeries = chart.addSeries(
      CandlestickSeries,
      {
        upColor: "#ffffff",
        downColor: "#111111",
        borderUpColor: "#111111",
        borderDownColor: "#111111",
        wickUpColor: "#111111",
        wickDownColor: "#111111",
        lastValueVisible: true,
        priceLineVisible: false,
      },
      0,
    );

    this.stochasticKSeries = chart.addSeries(
      LineSeries,
      {
        color: "#0f8f8a",
        lineWidth: 2,
        lastValueVisible: false,
        priceLineVisible: false,
        pointMarkersVisible: false,
        autoscaleInfoProvider: () => ({
          priceRange: { minValue: 0, maxValue: 100 },
        }),
      },
      1,
    );

    this.stochasticDSeries = chart.addSeries(
      LineSeries,
      {
        color: "#d32f2f",
        lineWidth: 2,
        lastValueVisible: false,
        priceLineVisible: false,
        pointMarkersVisible: false,
        autoscaleInfoProvider: () => ({
          priceRange: { minValue: 0, maxValue: 100 },
        }),
      },
      1,
    );

    this.rsiSeries = chart.addSeries(
      LineSeries,
      {
        color: "#2f80ff",
        lineWidth: 2,
        lastValueVisible: false,
        priceLineVisible: false,
        pointMarkersVisible: false,
        autoscaleInfoProvider: () => ({
          priceRange: { minValue: 0, maxValue: 100 },
        }),
      },
      2,
    );

    this.macdHistogramSeries = chart.addSeries(
      HistogramSeries,
      {
        base: 0,
        color: "#444444",
        lastValueVisible: false,
        priceLineVisible: false,
      },
      3,
    );

    this.macdSignalSeries = chart.addSeries(
      LineSeries,
      {
        color: "#d32f2f",
        lineWidth: 2,
        lastValueVisible: false,
        priceLineVisible: false,
        pointMarkersVisible: false,
      },
      3,
    );

    this.macdLineSeries = chart.addSeries(
      LineSeries,
      {
        color: "#6b7280",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        lastValueVisible: false,
        priceLineVisible: false,
        pointMarkersVisible: false,
      },
      3,
    );

    chart.priceScale("right", 1).applyOptions({
      autoScale: false,
      scaleMargins: {
        top: 0.08,
        bottom: 0.08,
      },
    });
    chart.priceScale("right", 2).applyOptions({
      autoScale: false,
      scaleMargins: {
        top: 0.08,
        bottom: 0.08,
      },
    });
    chart.priceScale("right", 3).applyOptions({
      autoScale: true,
      scaleMargins: {
        top: 0.12,
        bottom: 0.12,
      },
    });

    this.chartRef = chart;
    this.createIndicatorGuideLines();
  }

  private refreshChart(): void {
    if (
      !this.chartRef ||
      !this.priceSeries ||
      !this.stochasticKSeries ||
      !this.stochasticDSeries ||
      !this.rsiSeries ||
      !this.macdHistogramSeries ||
      !this.macdSignalSeries ||
      !this.macdLineSeries
    ) {
      return;
    }

    this.candles = this.normalizeCandles(this.initialCandles);
    this.error = this.candles.length ? null : "No candle data provided for divergence chart.";

    if (!this.candles.length) {
      this.priceSeries.setData([]);
      this.stochasticKSeries.setData([]);
      this.stochasticDSeries.setData([]);
      this.rsiSeries.setData([]);
      this.macdHistogramSeries.setData([]);
      this.macdSignalSeries.setData([]);
      this.macdLineSeries.setData([]);
      this.removeTrendlines();
      this.removeTradeLevels();
      return;
    }

    this.applyPriceFormat();

    this.priceSeries.setData(
      this.candles.map((candle) => ({
        time: this.toUtc(candle.time),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
    );

    const stochastic = calculateStochasticSeries(this.candles, 5, 3, 3);
    this.stochasticKSeries.setData(
      stochastic.map((point) => ({
        time: this.toUtc(point.time),
        value: point.k,
      })),
    );
    this.stochasticDSeries.setData(
      stochastic.map((point) => ({
        time: this.toUtc(point.time),
        value: point.d,
      })),
    );

    const rsi = calculateRsiSeries(this.candles, 14);
    this.rsiSeries.setData(
      rsi.map((point) => ({
        time: this.toUtc(point.time),
        value: point.value,
      })),
    );

    const macd = calculateMacdSeries(this.candles, 12, 29, 9);
    this.macdHistogramSeries.setData(
      macd.map((point) => ({
        time: this.toUtc(point.time),
        value: point.histogram,
        color: point.histogram >= 0 ? "#444444" : "#666666",
      })),
    );
    this.macdSignalSeries.setData(
      macd.map((point) => ({
        time: this.toUtc(point.time),
        value: point.signal,
      })),
    );
    this.macdLineSeries.setData(
      macd.map((point) => ({
        time: this.toUtc(point.time),
        value: point.macd,
      })),
    );

    this.renderTrendlines();
    this.renderTradeLevels();

    if (!this.autoFitApplied) {
      this.chartRef.timeScale().fitContent();
      this.autoFitApplied = true;
    }
  }

  private renderTrendlines(): void {
    if (!this.chartRef) {
      return;
    }

    this.removeTrendlines();

    const lines = this.normalizeTrendLines();
    for (const line of lines) {
      const series = this.chartRef.addSeries(
        LineSeries,
        {
          color: line.color,
          lineWidth: line.width,
          lineStyle: line.style === "dot" ? LineStyle.Dotted : LineStyle.Solid,
          lastValueVisible: false,
          priceLineVisible: false,
          pointMarkersVisible: false,
        },
        line.paneIndex,
      );

      series.setData(this.buildTrendLineData(line));
      this.overlayLineSeries.push(series);
    }
  }

  private renderTradeLevels(): void {
    if (!this.chartRef || !this.priceSeries || !this.candles.length) {
      return;
    }

    this.removeTradeLevels();

    const entry = this.parsePrice(this.entryPrice);
    const target = this.parsePrice(this.takeProfit);
    const stop = this.parsePrice(this.stopOrder);

    if (entry === null && target === null && stop === null) {
      return;
    }

    const tfSeconds = this.timeframeToSeconds(
      this.normalizeDisplayTimeframe(this.timeframe) || "M5",
    );

    // Не красим весь график от первой свечи — зона должна быть справа, как в статье.
    const startIndex = Math.max(this.candles.length - 10, 0);
    const startTime = this.candles[startIndex].time;
    const endTime = this.candles[this.candles.length - 1].time + (tfSeconds * 2);

    if (entry !== null && target !== null) {
      const takeProfitSeries = this.chartRef.addSeries(
        BaselineSeries,
        {
          baseValue: { type: "price", price: entry },
          topFillColor1: target > entry ? "rgba(76, 175, 80, 0.18)" : "rgba(0,0,0,0)",
          topFillColor2: target > entry ? "rgba(76, 175, 80, 0.18)" : "rgba(0,0,0,0)",
          topLineColor: target > entry ? "rgba(76, 175, 80, 0.9)" : "rgba(0,0,0,0)",
          bottomFillColor1: target < entry ? "rgba(76, 175, 80, 0.18)" : "rgba(0,0,0,0)",
          bottomFillColor2: target < entry ? "rgba(76, 175, 80, 0.18)" : "rgba(0,0,0,0)",
          bottomLineColor: target < entry ? "rgba(76, 175, 80, 0.9)" : "rgba(0,0,0,0)",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          baseLineVisible: false,
        },
        0,
      );
      takeProfitSeries.setData(this.buildBaselineData(startTime, endTime, target));
      this.tradeLevelAreaSeries.push(takeProfitSeries);
    }

    if (entry !== null && stop !== null) {
      const stopSeries = this.chartRef.addSeries(
        BaselineSeries,
        {
          baseValue: { type: "price", price: entry },
          topFillColor1: stop > entry ? "rgba(239, 83, 80, 0.16)" : "rgba(0,0,0,0)",
          topFillColor2: stop > entry ? "rgba(239, 83, 80, 0.16)" : "rgba(0,0,0,0)",
          topLineColor: stop > entry ? "rgba(239, 83, 80, 0.9)" : "rgba(0,0,0,0)",
          bottomFillColor1: stop < entry ? "rgba(239, 83, 80, 0.16)" : "rgba(0,0,0,0)",
          bottomFillColor2: stop < entry ? "rgba(239, 83, 80, 0.16)" : "rgba(0,0,0,0)",
          bottomLineColor: stop < entry ? "rgba(239, 83, 80, 0.9)" : "rgba(0,0,0,0)",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          baseLineVisible: false,
        },
        0,
      );
      stopSeries.setData(this.buildBaselineData(startTime, endTime, stop));
      this.tradeLevelAreaSeries.push(stopSeries);
    }

    if (entry !== null) {
      this.bindPriceLine(this.priceSeries, {
        price: entry,
        color: "#dc2626",
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: "Entry",
        lineVisible: true,
      });
    }

    if (target !== null) {
      this.bindPriceLine(this.priceSeries, {
        price: target,
        color: "#18a67d",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Target",
        lineVisible: true,
      });
    }

    if (stop !== null) {
      this.bindPriceLine(this.priceSeries, {
        price: stop,
        color: "#ef5350",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Stop",
        lineVisible: true,
      });
    }
  }

  private createIndicatorGuideLines(): void {
    if (!this.stochasticKSeries || !this.rsiSeries || !this.macdSignalSeries) {
      return;
    }

    this.removeIndicatorGuideLines();

    this.bindIndicatorGuideLine(this.stochasticKSeries, 80);
    this.bindIndicatorGuideLine(this.stochasticKSeries, 20);
    this.bindIndicatorGuideLine(this.rsiSeries, 70);
    this.bindIndicatorGuideLine(this.rsiSeries, 30);
    this.bindIndicatorGuideLine(this.macdSignalSeries, 0);
  }

  private bindIndicatorGuideLine(
    series: ISeriesApi<"Line">,
    price: number,
  ): void {
    const line = series.createPriceLine({
      price,
      color: "rgba(107, 114, 128, 0.5)",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: false,
      title: "",
      lineVisible: true,
    });

    this.indicatorGuideLines.push({ series, line });
  }

  private bindPriceLine(
    series:
      | ISeriesApi<"Candlestick">
      | ISeriesApi<"Line">
      | ISeriesApi<"Histogram">,
    options: Record<string, unknown>,
  ): void {
    const line = (series as any).createPriceLine(options);
    this.priceLines.push({ series, line });
  }

  private removeTrendlines(): void {
    if (!this.chartRef) {
      this.overlayLineSeries = [];
      return;
    }

    for (const series of this.overlayLineSeries) {
      try {
        this.chartRef.removeSeries(series);
      } catch (error) {
        console.warn("Failed to remove divergence trendline", error);
      }
    }

    this.overlayLineSeries = [];
  }

  private removeTradeLevels(): void {
    if (this.chartRef) {
      for (const series of this.tradeLevelAreaSeries) {
        try {
          this.chartRef.removeSeries(series);
        } catch (error) {
          console.warn("Failed to remove divergence trade level area", error);
        }
      }
    }
    this.tradeLevelAreaSeries = [];

    for (const binding of this.priceLines) {
      try {
        (binding.series as any).removePriceLine(binding.line);
      } catch (error) {
        console.warn("Failed to remove divergence price line", error);
      }
    }
    this.priceLines = [];
  }

  private removeIndicatorGuideLines(): void {
    for (const binding of this.indicatorGuideLines) {
      try {
        (binding.series as any).removePriceLine(binding.line);
      } catch (error) {
        console.warn("Failed to remove divergence guide line", error);
      }
    }
    this.indicatorGuideLines = [];
  }

  private destroyChart(): void {
    if (!this.chartRef) {
      return;
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

  private normalizeCandles(rawCandles: any[] | null): Candle[] {
    return (Array.isArray(rawCandles) ? rawCandles : [])
      .map((candle) => this.normalizeCandle(candle))
      .filter((candle: Candle | null): candle is Candle => !!candle)
      .sort((left: Candle, right: Candle) => left.time - right.time);
  }

  private normalizeCandle(rawCandle: any): Candle | null {
    if (!rawCandle) {
      return null;
    }

    const time = this.readNumber(rawCandle, ["time", "Time", "t", "T"]);
    const open = this.readNumber(rawCandle, ["open", "Open", "o", "O"]);
    const high = this.readNumber(rawCandle, ["high", "High", "h", "H"]);
    const low = this.readNumber(rawCandle, ["low", "Low", "l", "L"]);
    const close = this.readNumber(rawCandle, ["close", "Close", "c", "C"]);
    const volume = this.readOptionalNumber(rawCandle, [
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
      time: Number(this.toUtc(time)),
      open,
      high,
      low,
      close,
      volume,
    };
  }

  private normalizeTrendLines(): NormalizedTrendLine[] {
    const source = Array.isArray(this.trendLines) && this.trendLines.length
      ? this.trendLines
      : Array.isArray(this.objects)
        ? this.objects
        : [];

    return source
      .map((line, index) => this.normalizeTrendLine(line, index))
      .filter((line: NormalizedTrendLine | null): line is NormalizedTrendLine => !!line);
  }

  private normalizeTrendLine(
    rawLine: any,
    lineIndex: number,
  ): NormalizedTrendLine | null {
    if (rawLine?.type !== "trendline") {
      return null;
    }

    const rawPoints = Array.isArray(rawLine?.points) ? rawLine.points : [];
    if (rawPoints.length < 2) {
      return null;
    }

    const points = rawPoints
      .map((point: any) => {
        const time = this.readNumber(point, ["time", "Time"]);
        const value = this.readNumber(point, ["price", "Price", "value", "Value"]);
        if (time === null || value === null) {
          return null;
        }

        return {
          time: this.resolveTrendLineTime(Number(this.toUtc(time))),
          value,
        };
      })
      .filter(
        (
          point: { time: number; value: number } | null,
        ): point is { time: number; value: number } =>
          !!point && point.time > 0 && Number.isFinite(point.value),
      )
      .sort(
        (
          left: { time: number; value: number },
          right: { time: number; value: number },
        ) => left.time - right.time,
      );

    if (points.length < 2) {
      return null;
    }

    const paneIndex = this.resolveTrendLinePaneIndex(rawLine, points, lineIndex);
    const width = Math.min(Math.max(Number(rawLine?.width ?? 2), 1), 4) as
      | 1
      | 2
      | 3
      | 4;

    return {
      color: String(rawLine?.color ?? "#42D433"),
      width,
      style: String(rawLine?.style ?? "solid").toLowerCase() === "dot" ? "dot" : "solid",
      rayRight: !!rawLine?.ray_right,
      paneIndex,
      p1: points[0],
      p2: points[points.length - 1],
    };
  }

  private resolveTrendLinePaneIndex(
    rawLine: any,
    points: Array<{ time: number; value: number }>,
    lineIndex: number,
  ): number {
    const explicitPane = `${rawLine?.pane ?? rawLine?.panel ?? ""}`.trim().toLowerCase();
    if (explicitPane.includes("stoch")) {
      return 1;
    }
    if (explicitPane.includes("rsi")) {
      return 2;
    }
    if (explicitPane.includes("macd")) {
      return 3;
    }

    if (this.looksPriceLike(points)) {
      return 0;
    }

    const indicator = `${rawLine?.indicator ?? ""}`.trim().toLowerCase();
    if (indicator.includes("stoch")) {
      return 1;
    }
    if (indicator.includes("rsi")) {
      return 2;
    }
    if (indicator.includes("macd")) {
      return 3;
    }

    return lineIndex === 0 ? 0 : 2;
  }

  private looksPriceLike(points: Array<{ value: number }>): boolean {
    if (!this.candles.length) {
      return false;
    }

    let minPrice = Number.POSITIVE_INFINITY;
    let maxPrice = Number.NEGATIVE_INFINITY;

    for (const candle of this.candles) {
      minPrice = Math.min(minPrice, candle.low);
      maxPrice = Math.max(maxPrice, candle.high);
    }

    const padding = Math.max((maxPrice - minPrice) * 0.25, this.getPriceMinMove() * 10);
    return points.every(
      (point) => point.value >= minPrice - padding && point.value <= maxPrice + padding,
    );
  }

  private buildTrendLineData(
    line: NormalizedTrendLine,
  ): Array<{ time: UTCTimestamp; value: number }> {
    const data = [
      { time: this.toUtc(line.p1.time), value: line.p1.value },
      { time: this.toUtc(line.p2.time), value: line.p2.value },
    ];

    if (!line.rayRight) {
      return data;
    }

    const tfSeconds = this.timeframeToSeconds(
      this.normalizeDisplayTimeframe(this.timeframe) || "M5",
    );
    const endTime = Math.max(line.p2.time + (tfSeconds * 15), line.p1.time + 1);
    const dt = line.p2.time - line.p1.time;
    const endValue =
      dt === 0
        ? line.p2.value
        : line.p2.value + (((line.p2.value - line.p1.value) / dt) * (endTime - line.p2.time));

    data.push({
      time: this.toUtc(endTime),
      value: endValue,
    });

    return data;
  }

  private buildBaselineData(
    startTime: number,
    endTime: number,
    value: number,
  ): Array<{ time: UTCTimestamp; value: number }> {
    return [
      { time: this.toUtc(startTime), value },
      { time: this.toUtc(endTime), value },
    ];
  }

  private resolveTrendLineTime(rawTime: number): number {
    if (!this.candles.length) {
      return rawTime;
    }

    const tfSeconds = this.timeframeToSeconds(
      this.normalizeDisplayTimeframe(this.timeframe) || "M5",
    );
    let nearestTime = this.candles[0].time;
    let nearestDistance = Math.abs(nearestTime - rawTime);

    for (const candle of this.candles) {
      const distance = Math.abs(candle.time - rawTime);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestTime = candle.time;
      }
    }

    return nearestDistance <= tfSeconds ? nearestTime : rawTime;
  }

  private applyPriceFormat(): void {
    if (!this.priceSeries) {
      return;
    }

    const priceValues = this.candles.flatMap((candle) => [
      candle.open,
      candle.high,
      candle.low,
      candle.close,
    ]);

    const entry = this.parsePrice(this.entryPrice);
    const target = this.parsePrice(this.takeProfit);
    const stop = this.parsePrice(this.stopOrder);
    if (entry !== null) {
      priceValues.push(entry);
    }
    if (target !== null) {
      priceValues.push(target);
    }
    if (stop !== null) {
      priceValues.push(stop);
    }

    const precision = this.inferPrecision(priceValues);
    this.priceSeries.applyOptions({
      priceFormat: {
        type: "price",
        precision,
        minMove: precision > 0 ? 1 / Math.pow(10, precision) : 1,
      },
    });
  }

  private inferPrecision(values: number[]): number {
    let precision = 2;

    for (const value of values) {
      if (!Number.isFinite(value)) {
        continue;
      }

      const text = value.toString().toLowerCase();
      if (text.includes("e-")) {
        const exponent = Number(text.split("e-")[1] || 0);
        precision = Math.max(precision, exponent);
        continue;
      }

      const separatorIndex = text.indexOf(".");
      if (separatorIndex >= 0) {
        precision = Math.max(precision, text.length - separatorIndex - 1);
      }
    }

    return Math.min(Math.max(precision, 2), 10);
  }

  private getPriceMinMove(): number {
    const precision = this.inferPrecision(
      this.candles.flatMap((candle) => [candle.open, candle.high, candle.low, candle.close]),
    );
    return precision > 0 ? 1 / Math.pow(10, precision) : 1;
  }

  private parsePrice(value: string | null): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  private readNumber(source: any, keys: string[]): number | null {
    for (const key of keys) {
      const value = source?.[key];
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

  private readOptionalNumber(source: any, keys: string[]): number | undefined {
    const value = this.readNumber(source, keys);
    return value === null ? undefined : value;
  }

  private toUtc(timestamp: number | string): UTCTimestamp {
    const value = typeof timestamp === "string" ? Number(timestamp) : timestamp;
    const seconds =
      value > 1e12 ? Math.floor(value / 1000) : Math.floor(value || 0);
    return seconds as UTCTimestamp;
  }

  private normalizeDisplayTimeframe(value: string): string {
    if (!value) {
      return "";
    }

    const prepared = value
      .trim()
      .replace(/\u041c/g, "M")
      .replace(/\u043c/g, "m");

    if (/^\d+$/.test(prepared)) {
      return `M${prepared}`;
    }

    const upper = prepared.toUpperCase();
    if (upper === "MN") {
      return "MN1";
    }
    if (/^M\d+$/.test(upper) || /^H\d+$/.test(upper)) {
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

    return 300;
  }
}
