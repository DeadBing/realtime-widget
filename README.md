# RealtimeWidget

Standalone realtime chart widget intended to be embedded via `iframe` from any website.

## Embed Contract

Widget URL example:

```text
https://your-widget-host/widget?hubUrl=https%3A%2F%2Fferma-api.bondah.com&symbol=GBPNZD&timeframe=M30&source=ohlc&active=true&height=500
```

Supported query params:

- `hubUrl` (required): backend API root; widget connects to `${hubUrl}/hubs/quotes`
- `symbol` (optional): instrument, default `""`
- `timeframe` (optional): default `M15`
- `source` (optional): default `ohlc`
- `active` (optional): `true|false`, default `true`
- `height` (optional): number, default `500`
- `chartMode` (optional): `pattern|divergence`; if omitted, widget auto-detects divergence mode from `trendLines` or indicator-tagged line payloads
- `takeProfit` (optional)
- `stopOrder` (optional)
- `entryPrice` (optional)
- `initialCandles` (optional, base64 JSON array)
- `objects` (optional, base64 JSON array)
- `trendLines` (optional, base64 JSON array): divergence line payload for price/indicator panes
- `chartData` (optional, base64 JSON object/array): raw article chart payload; widget extracts `candles`/`bars`, `objects`, and `trendLines`

### Recommended way for large payloads

Instead of putting large `initialCandles`/`objects` into URL (can cause HTTP 431), send them with `postMessage` after iframe load:

```html
<iframe
	id="rt-widget"
	src="https://your-widget-host/widget?hubUrl=https%3A%2F%2Fferma-api.bondah.com&symbol=GBPNZD&timeframe=M30&source=ohlc&active=true&height=500"
	style="width: 100%; height: 500px; border: 0"
></iframe>
<script>
	const iframe = document.getElementById("rt-widget");
	const widgetOrigin = new URL(iframe.src).origin;

	iframe.addEventListener("load", () => {
		iframe.contentWindow.postMessage(
			{
				type: "realtime-widget-config",
				hubUrl: "https://ferma-api.bondah.com",
				symbol: "GBPNZD",
				timeframe: "M30",
				source: "ohlc",
				active: true,
				height: 500,
				chartMode: "divergence",
				initialCandles: [],
				objects: [],
				trendLines: [],
			},
			widgetOrigin,
		);
	});
</script>
```

The widget listens for `message` events with `type: "realtime-widget-config"` and applies fields dynamically.

## Divergence mode

Use divergence mode when the payload contains oscillator panes and `trendLines` for price / RSI / Stochastic / MACD. The current implementation is intentionally `v1 static`:

- 4 panes: `Price -> Stochastic -> RSI -> MACD`
- price pane includes candles, trade levels, and price-side divergence line
- indicator panes calculate values from the same seeded candle timestamps, then render pane-specific divergence lines
- realtime continuation stays on the existing pattern component for now; divergence mode is split into a dedicated component to avoid regressions in the working triangle renderer

## Angular Host Wrapper Note

This repository also contains Angular host wrapper components in `frontend` and `constructor.4casto`. They are optional helpers for internal apps only; external integrators can embed the widget directly with plain HTML `iframe`.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Karma](https://karma-runner.github.io) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
