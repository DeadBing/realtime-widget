export type IndicatorCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type IndicatorPoint = {
  time: number;
  value: number;
};

export type StochasticPoint = {
  time: number;
  k: number;
  d: number;
};

export type MacdPoint = {
  time: number;
  macd: number;
  signal: number;
  histogram: number;
};

export function calculateRsiSeries(
  candles: IndicatorCandle[],
  period = 14,
): IndicatorPoint[] {
  if (candles.length <= period) {
    return [];
  }

  let gainSum = 0;
  let lossSum = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = candles[index].close - candles[index - 1].close;
    if (delta >= 0) {
      gainSum += delta;
    } else {
      lossSum += Math.abs(delta);
    }
  }

  let averageGain = gainSum / period;
  let averageLoss = lossSum / period;
  const series: IndicatorPoint[] = [];

  series.push({
    time: candles[period].time,
    value: calculateRsiValue(averageGain, averageLoss),
  });

  for (let index = period + 1; index < candles.length; index += 1) {
    const delta = candles[index].close - candles[index - 1].close;
    const gain = Math.max(delta, 0);
    const loss = Math.max(-delta, 0);

    averageGain = ((averageGain * (period - 1)) + gain) / period;
    averageLoss = ((averageLoss * (period - 1)) + loss) / period;

    series.push({
      time: candles[index].time,
      value: calculateRsiValue(averageGain, averageLoss),
    });
  }

  return series;
}

export function calculateStochasticSeries(
  candles: IndicatorCandle[],
  kPeriod = 5,
  kSmoothing = 3,
  dPeriod = 3,
): StochasticPoint[] {
  if (candles.length < kPeriod + kSmoothing + dPeriod - 2) {
    return [];
  }

  const rawK: Array<IndicatorPoint | null> = new Array(candles.length).fill(null);
  for (let index = kPeriod - 1; index < candles.length; index += 1) {
    let highestHigh = Number.NEGATIVE_INFINITY;
    let lowestLow = Number.POSITIVE_INFINITY;

    for (let inner = index - kPeriod + 1; inner <= index; inner += 1) {
      highestHigh = Math.max(highestHigh, candles[inner].high);
      lowestLow = Math.min(lowestLow, candles[inner].low);
    }

    const range = highestHigh - lowestLow;
    const value = range === 0 ? 50 : ((candles[index].close - lowestLow) / range) * 100;

    rawK[index] = {
      time: candles[index].time,
      value,
    };
  }

  const smoothedK = calculateSmaOverNullable(rawK, kSmoothing);
  const smoothedD = calculateSmaOverNullable(smoothedK, dPeriod);
  const series: StochasticPoint[] = [];

  for (let index = 0; index < candles.length; index += 1) {
    const kPoint = smoothedK[index];
    const dPoint = smoothedD[index];
    if (!kPoint || !dPoint) {
      continue;
    }

    series.push({
      time: candles[index].time,
      k: kPoint.value,
      d: dPoint.value,
    });
  }

  return series;
}

// В статьях у вас MACD(12,29,9), а не 12/26/9.
export function calculateMacdSeries(
  candles: IndicatorCandle[],
  fastPeriod = 12,
  slowPeriod = 29,
  signalPeriod = 9,
): MacdPoint[] {
  if (candles.length < slowPeriod + signalPeriod) {
    return [];
  }

  const closes = candles.map((candle) => candle.close);
  const fastEma = calculateEmaSeries(closes, fastPeriod);
  const slowEma = calculateEmaSeries(closes, slowPeriod);

  const macdValues: Array<number | null> = closes.map((_, index) => {
    const fast = fastEma[index];
    const slow = slowEma[index];
    if (fast === null || slow === null) {
      return null;
    }
    return fast - slow;
  });

  const signalValues = calculateEmaSeries(macdValues, signalPeriod);
  const series: MacdPoint[] = [];

  for (let index = 0; index < candles.length; index += 1) {
    const macd = macdValues[index];
    const signal = signalValues[index];
    if (macd === null || signal === null) {
      continue;
    }

    series.push({
      time: candles[index].time,
      macd,
      signal,
      histogram: macd - signal,
    });
  }

  return series;
}

function calculateRsiValue(averageGain: number, averageLoss: number): number {
  if (averageLoss === 0) {
    return averageGain === 0 ? 50 : 100;
  }

  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

function calculateSmaOverNullable(
  points: Array<IndicatorPoint | null>,
  period: number,
): Array<IndicatorPoint | null> {
  const result: Array<IndicatorPoint | null> = new Array(points.length).fill(null);

  for (let index = 0; index < points.length; index += 1) {
    if (index < period - 1) {
      continue;
    }

    let sum = 0;
    let valid = true;

    for (let inner = index - period + 1; inner <= index; inner += 1) {
      const point = points[inner];
      if (!point) {
        valid = false;
        break;
      }
      sum += point.value;
    }

    if (!valid || !points[index]) {
      continue;
    }

    result[index] = {
      time: points[index]!.time,
      value: sum / period,
    };
  }

  return result;
}

function calculateEmaSeries(
  values: Array<number | null>,
  period: number,
): Array<number | null> {
  const result: Array<number | null> = new Array(values.length).fill(null);
  const multiplier = 2 / (period + 1);

  const seedIndices: number[] = [];
  const seedValues: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === null) {
      continue;
    }

    seedIndices.push(index);
    seedValues.push(value);

    if (seedValues.length < period) {
      continue;
    }

    const seedIndex = seedIndices[period - 1];
    const seedAverage = seedValues.slice(0, period).reduce((sum, current) => sum + current, 0) / period;
    result[seedIndex] = seedAverage;

    for (let inner = seedIndex + 1; inner < values.length; inner += 1) {
      const innerValue = values[inner];
      if (innerValue === null) {
        continue;
      }

      const previousIndex = findPreviousDefinedIndex(result, inner - 1);
      if (previousIndex < 0 || result[previousIndex] === null) {
        continue;
      }

      result[inner] = ((innerValue - result[previousIndex]!) * multiplier) + result[previousIndex]!;
    }

    break;
  }

  return result;
}

function findPreviousDefinedIndex(values: Array<number | null>, startIndex: number): number {
  for (let index = startIndex; index >= 0; index -= 1) {
    if (values[index] !== null) {
      return index;
    }
  }
  return -1;
}
