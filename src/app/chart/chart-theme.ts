export type ChartTheme = 'light' | 'dark';

export interface ChartPalette {
  background: string;
  text: string;
  grid: string;
  crosshair: string;
  up: string;
  down: string;
  blue: string;
  orange: string;
  macdMain: string;
  macdPositive: string;
  macdNegative: string;
}

export const LIGHT_PALETTE: ChartPalette = {
  background: '#ffffff',
  text: '#374151',
  grid: 'rgba(0, 0, 0, 0.08)',
  crosshair: 'rgba(55, 65, 81, 0.25)',
  up: '#26a69a',
  down: '#ef5350',
  blue: '#2962ff',
  orange: '#ff6d00',
  macdMain: '#7f8c8d',
  macdPositive: 'rgba(38, 166, 154, 0.85)',
  macdNegative: 'rgba(239, 83, 80, 0.85)',
};

export const DARK_PALETTE: ChartPalette = {
  background: '#0D1117',
  text: '#B8BBC4',
  grid: 'rgba(255, 255, 255, 0.06)',
  crosshair: 'rgba(184, 187, 196, 0.25)',
  up: '#28B898',
  down: '#C44858',
  blue: '#4888B8',
  orange: '#ff6d00',
  macdMain: '#7f8c8d',
  macdPositive: 'rgba(40, 184, 152, 0.85)',
  macdNegative: 'rgba(196, 72, 88, 0.85)',
};

export function getPalette(theme: ChartTheme): ChartPalette {
  return theme === 'dark' ? DARK_PALETTE : LIGHT_PALETTE;
}
