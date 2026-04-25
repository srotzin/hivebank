// HiveOracle — spectral price mapping.
// HiveFilter primitive boost: Colors (#5) + H-Spectrum (#7).
//
// Volatility regime → spectrum band. Operators *see* regime shifts.
// Patent-fresh: drafts as #10 (spectral price oracle).
//
// Volatility (rolling stddev / mean) → H-spectrum band:
//   < 0.005   → Hα   656.3 nm (red)         deep stable
//   < 0.02    → Hβ   486.1 nm (cyan)        normal
//   < 0.05    → Hγ   434.0 nm (blue)        elevated
//   < 0.10    → Hδ   410.2 nm (violet)      high
//   < 0.25    → Lyα  121.6 nm (UV)          extreme
//   ≥ 0.25    → Lyβ  102.6 nm (UV)          crisis
'use strict';

const REGIMES = [
  { name: 'STABLE_RED',     max: 0.005, line: 'Halpha', wavelength_nm: 656.3, hex: '#FF2A1F' },
  { name: 'NORMAL_CYAN',    max: 0.020, line: 'Hbeta',  wavelength_nm: 486.1, hex: '#1FE6FF' },
  { name: 'ELEVATED_BLUE',  max: 0.050, line: 'Hgamma', wavelength_nm: 434.0, hex: '#4A7BFF' },
  { name: 'HIGH_VIOLET',    max: 0.100, line: 'Hdelta', wavelength_nm: 410.2, hex: '#7A1FFF' },
  { name: 'EXTREME_UVA',    max: 0.250, line: 'Lyalpha',wavelength_nm: 121.6, hex: '#9D00FF' },
  { name: 'CRISIS_UVB',     max: Infinity,line: 'Lybeta',wavelength_nm:102.6, hex: '#5D00FF' }
];

function classifyVolatility(stddev_over_mean) {
  const v = Number(stddev_over_mean);
  if (!Number.isFinite(v) || v < 0) return REGIMES[0];
  for (const r of REGIMES) if (v < r.max) return r;
  return REGIMES[REGIMES.length - 1];
}

// Compute (mean, stddev, vol_ratio) from a window of prices.
function windowStats(prices) {
  const xs = (prices || []).filter(Number.isFinite);
  if (xs.length === 0) return { mean: 0, stddev: 0, vol_ratio: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (xs.length === 1) return { mean, stddev: 0, vol_ratio: 0, n: 1 };
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  const stddev = Math.sqrt(variance);
  const vol_ratio = mean === 0 ? 0 : stddev / Math.abs(mean);
  return { mean, stddev, vol_ratio, n: xs.length };
}

// Top-level: price window → spectral classification + summary.
function classifyPriceWindow(prices) {
  const stats = windowStats(prices);
  const regime = classifyVolatility(stats.vol_ratio);
  return {
    regime: regime.name,
    line: regime.line,
    wavelength_nm: regime.wavelength_nm,
    hex_color: regime.hex,
    stats
  };
}

module.exports = { REGIMES, classifyVolatility, windowStats, classifyPriceWindow };
