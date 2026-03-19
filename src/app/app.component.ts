import { Component, OnInit, PLATFORM_ID, inject } from "@angular/core";
import { isPlatformBrowser } from "@angular/common";
import { RealtimeDivergenceChartComponent } from "./chart/realtime-divergence-chart.component";
import { RealtimeTradingviewChartComponent } from "./chart/realtime-tradingview-chart.component";
import { WidgetConfigService } from "./chart/widget-config.service";

type ChartMode = "pattern" | "divergence";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [
    RealtimeTradingviewChartComponent,
    RealtimeDivergenceChartComponent,
  ],
  template: `
    @if (resolvedChartMode === "divergence") {
      <app-realtime-divergence-chart
        [symbol]="symbol"
        [timeframe]="timeframe"
        [source]="source"
        [active]="active"
        [height]="height"
        [initialCandles]="initialCandles"
        [trendLines]="trendLines"
        [objects]="objects"
        [takeProfit]="takeProfit"
        [stopOrder]="stopOrder"
        [entryPrice]="entryPrice"
        [signalStatus]="signalStatus"
        (currentPriceChange)="publishCurrentPrice($event)"
      ></app-realtime-divergence-chart>
    } @else {
      <app-realtime-tradingview-chart
        [symbol]="symbol"
        [timeframe]="timeframe"
        [source]="source"
        [active]="active"
        [height]="height"
        [initialCandles]="initialCandles"
        [objects]="objects"
        [takeProfit]="takeProfit"
        [stopOrder]="stopOrder"
        [entryPrice]="entryPrice"
        [signalStatus]="signalStatus"
        (currentPriceChange)="publishCurrentPrice($event)"
      ></app-realtime-tradingview-chart>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        max-width: 1280px;
        height: 800px;
        margin: 0;
        padding: 0;
        overflow: hidden;
      }
    `,
  ],
})
export class AppComponent implements OnInit {
  symbol = "";
  timeframe = "M15";
  source = "ohlc";
  active = true;
  height = 800;
  initialCandles: any[] | null = null;
  objects: any[] | null = null;
  trendLines: any[] | null = null;
  takeProfit: string | null = null;
  stopOrder: string | null = null;
  entryPrice: string | null = null;
  signalStatus: number | null = null;
  chartMode: ChartMode | null = null;

  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);
  private messageListenerBound = false;
  private lastPublishedPrice: number | null = null;

  private readonly widgetConfig = inject(WidgetConfigService);

  get resolvedChartMode(): ChartMode {
    if (this.chartMode) {
      return this.chartMode;
    }

    if (Array.isArray(this.trendLines) && this.trendLines.length) {
      return "divergence";
    }

    if (
      Array.isArray(this.objects) &&
      this.objects.some((object) => `${object?.indicator ?? ""}`.trim())
    ) {
      return "divergence";
    }

    return "pattern";
  }

  ngOnInit(): void {
    if (!this.isBrowser) {
      return;
    }

    const params = new URLSearchParams(window.location.search);

    this.widgetConfig.hubUrl = params.get("hubUrl") || "";
    this.symbol = params.get("symbol") || "";
    this.timeframe = params.get("timeframe") || "M15";
    this.source = params.get("source") || "ohlc";
    this.active = params.get("active") !== "false";
    this.height = Number(params.get("height")) || 500;
    this.chartMode = this.normalizeChartMode(params.get("chartMode"));
    this.takeProfit = params.get("takeProfit") || null;
    this.stopOrder = params.get("stopOrder") || null;
    this.entryPrice = params.get("entryPrice") || null;
    const rawSignalStatus = params.get("signalStatus");
    this.signalStatus = rawSignalStatus !== null ? Number(rawSignalStatus) : null;

    this.initialCandles = this.decodeArrayParam(params.get("initialCandles"));
    this.objects = this.decodeArrayParam(params.get("objects"));
    this.trendLines = this.decodeArrayParam(params.get("trendLines"));
    this.applyChartData(this.decodeJsonParam(params.get("chartData")));

    this.listenForParentMessages();
  }

  private decodeArrayParam(value: string | null): any[] | null {
    const parsed = this.decodeJsonParam(value);
    return Array.isArray(parsed) ? parsed : null;
  }

  private decodeJsonParam(value: string | null): unknown {
    if (!value) {
      return null;
    }

    try {
      return JSON.parse(atob(value));
    } catch {
      console.warn("Failed to decode base64 JSON param");
      return null;
    }
  }

  private listenForParentMessages(): void {
    if (this.messageListenerBound) {
      return;
    }

    this.messageListenerBound = true;
    const allowedOrigin = window.location.origin;
    window.addEventListener("message", (event: MessageEvent) => {
      // Accept messages only from same origin or parent that embedded us
      if (event.origin !== allowedOrigin && event.source !== window.parent) {
        return;
      }

      const data = event.data;
      if (!data || data.type !== "realtime-widget-config") {
        return;
      }

      if (data.hubUrl) {
        this.widgetConfig.hubUrl = data.hubUrl;
      }
      if (data.symbol !== undefined) {
        this.symbol = data.symbol;
      }
      if (data.timeframe !== undefined) {
        this.timeframe = data.timeframe;
      }
      if (data.source !== undefined) {
        this.source = data.source;
      }
      if (data.active !== undefined) {
        this.active = data.active;
      }
      if (data.height !== undefined) {
        this.height = data.height;
      }
      if (data.chartMode !== undefined) {
        this.chartMode = this.normalizeChartMode(data.chartMode);
      }
      if (data.initialCandles !== undefined) {
        this.initialCandles = data.initialCandles;
      }
      if (data.objects !== undefined) {
        this.objects = data.objects;
      }
      if (data.trendLines !== undefined) {
        this.trendLines = data.trendLines;
      }
      if (data.chartData !== undefined) {
        this.applyChartData(data.chartData);
      }
      if (data.takeProfit !== undefined) {
        this.takeProfit = data.takeProfit;
      }
      if (data.stopOrder !== undefined) {
        this.stopOrder = data.stopOrder;
      }
      if (data.entryPrice !== undefined) {
        this.entryPrice = data.entryPrice;
      }
      if (data.signalStatus !== undefined) {
        this.signalStatus = data.signalStatus !== null ? Number(data.signalStatus) : null;
      }
    });
  }

  private applyChartData(rawChartData: unknown): void {
    const normalized = this.normalizeChartData(rawChartData);
    if (!normalized) {
      return;
    }

    if (Array.isArray(normalized["candles"])) {
      this.initialCandles = normalized["candles"];
    } else if (Array.isArray(normalized["bars"])) {
      this.initialCandles = normalized["bars"];
    }

    if (Array.isArray(normalized["objects"])) {
      this.objects = normalized["objects"];
    }

    if (Array.isArray(normalized["trendLines"])) {
      this.trendLines = normalized["trendLines"];
    }

    const payloadSymbol = `${normalized["symbol"] ?? ""}`.trim();
    if (payloadSymbol) {
      this.symbol = payloadSymbol;
    }

    const payloadTimeframe = `${normalized["period"] ?? normalized["timeframe"] ?? ""}`.trim();
    if (payloadTimeframe) {
      this.timeframe = payloadTimeframe;
    }
  }

  publishCurrentPrice(currentPrice: number): void {
    if (!this.isBrowser || !Number.isFinite(currentPrice)) {
      return;
    }

    const roundedPrice = Math.round(currentPrice * 100000) / 100000;
    if (this.lastPublishedPrice === roundedPrice) {
      return;
    }

    this.lastPublishedPrice = roundedPrice;
    window.parent.postMessage(
      {
        type: "realtime-widget-price",
        symbol: this.symbol,
        timeframe: this.timeframe,
        source: this.source,
        currentPrice: roundedPrice,
      },
      "*",
    );
  }

  private normalizeChartData(rawChartData: unknown): Record<string, any> | null {
    if (!rawChartData) {
      return null;
    }

    const candidate = Array.isArray(rawChartData) ? rawChartData[0] : rawChartData;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return null;
    }

    return candidate as Record<string, any>;
  }

  private normalizeChartMode(value: unknown): ChartMode | null {
    const normalized = `${value ?? ""}`.trim().toLowerCase();
    if (normalized === "pattern" || normalized === "divergence") {
      return normalized;
    }

    return null;
  }
}
