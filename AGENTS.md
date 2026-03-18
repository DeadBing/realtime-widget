# Realtime Widget

## Назначение

`realtime-widget/` это отдельное Angular-приложение для iframe-графиков. Оно используется из `frontend/` и `constructor.4casto/`, но может встраиваться и напрямую через `iframe`.

## Активные точки входа

- `src/app/app.component.ts`: читает конфиг из query params и `postMessage`, выбирает режим рендера
- `src/app/chart/quotes-hub-connection.service.ts`: SignalR-подключение к backend
- `src/app/chart/realtime-tradingview-chart.component.ts`: pattern mode
- `src/app/chart/realtime-divergence-chart.component.ts`: divergence mode
- `src/app/chart/chart-utils.ts`, `divergence-indicators.ts`: нормализация данных и расчёты индикаторов

## Инварианты

- Контракт виджета строится вокруг query params и `postMessage`. Если меняешь входной формат, обновляй и потребителей в `frontend/` и `constructor.4casto/`.
- Realtime идёт через backend SignalR hub `/hubs/quotes`.
- В папке `src/app/chart/` есть `.fixed.ts` файлы. Это не основные точки входа; рабочие версии без суффикса `.fixed.ts`.
- Проект небольшой, но изменения в трансформации свечей, таймфреймов или индикаторов легко ломают оба режима сразу.

## Где искать

- Разбор конфигурации iframe: `src/app/app.component.ts`
- SignalR: `src/app/chart/quotes-hub-connection.service.ts`
- Pattern chart: `src/app/chart/realtime-tradingview-chart.component.ts`
- Divergence chart: `src/app/chart/realtime-divergence-chart.component.ts`
- Вспомогательная математика и нормализация: `src/app/chart/chart-utils.ts`, `src/app/chart/divergence-indicators.ts`

## Команды

```bash
npm start
npm run build
npm test
```
