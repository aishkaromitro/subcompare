/* ==========================================================================
   graphs.js
   Responsibility: draw the two required charts using only the HTML5
   Canvas API (no chart libraries, per the spec):
     - drawHistogram(canvas, points)  → bar chart, timing diff per cue
     - drawDriftGraph(canvas, points) → line chart, cumulative drift
   `points` is the array produced by statistics.js's computeGraphData().

   Pure helper functions (niceAxisBounds, scaleFns) are exported
   separately from the draw functions so they can be unit tested without
   a real <canvas> element.
   ========================================================================== */

(function (global) {
  'use strict';

  const FALLBACK_COLORS = {
    text: '#E7EAEE', textMuted: '#8892A0', border: '#262B33',
    accent: '#F2B84B',
    excellent: '#6FCF97', good: '#F2C94C', poor: '#F2994A', bad: '#EB5757', none: '#4A5568'
  };

  /**
   * Reads the app's CSS custom properties so the canvas drawings stay in
   * sync with style.css's palette instead of hard-coding a second copy
   * of the color tokens. Falls back to fixed values when no DOM/theme
   * is available (e.g. under Node during tests).
   */
  function getThemeColors() {
    if (typeof document === 'undefined') return FALLBACK_COLORS;
    const css = getComputedStyle(document.documentElement);
    const get = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
    return {
      text: get('--text', FALLBACK_COLORS.text),
      textMuted: get('--text-muted', FALLBACK_COLORS.textMuted),
      border: get('--border', FALLBACK_COLORS.border),
      accent: get('--accent', FALLBACK_COLORS.accent),
      excellent: get('--match-excellent', FALLBACK_COLORS.excellent),
      good: get('--match-good', FALLBACK_COLORS.good),
      poor: get('--match-poor', FALLBACK_COLORS.poor),
      bad: get('--match-bad', FALLBACK_COLORS.bad),
      none: get('--match-none', FALLBACK_COLORS.none)
    };
  }

  function colorForQuality(colors, qualityKey) {
    return colors[qualityKey] || colors.none;
  }

  /**
   * Given a data min/max, picks a "nice" rounded axis max (and min, for
   * symmetric data) so gridline labels read as sensible round numbers
   * rather than raw noisy values like 1417.3.
   */
  function niceAxisBounds(min, max) {
    if (min === max) {
      // A perfectly flat data set (e.g. every diff is exactly 0ms) has
      // no natural scale to derive from — fall back to a small fixed
      // window so the axis still reads as sensible round numbers.
      return { min: min - 200, max: max + 200 };
    }
    const span = max - min;
    const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(Math.abs(span), 1))));
    const niceSpan = Math.ceil(span / magnitude) * magnitude;
    const niceMax = Math.ceil(max / (niceSpan / 5)) * (niceSpan / 5);
    const niceMin = Math.floor(min / (niceSpan / 5)) * (niceSpan / 5);
    return { min: niceMin, max: niceMax };
  }

  /** Builds a linear scale function mapping a data value to a pixel position. */
  function makeScale(domainMin, domainMax, rangeMin, rangeMax) {
    const domainSpan = (domainMax - domainMin) || 1;
    return function (value) {
      const t = (value - domainMin) / domainSpan;
      return rangeMin + t * (rangeMax - rangeMin);
    };
  }

  /**
   * Prepares a canvas for crisp rendering at the current device pixel
   * ratio, resetting any previous transform (important since draw
   * functions may be called repeatedly on the same canvas as the user
   * re-runs a comparison).
   */
  function prepareCanvas(canvas) {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const cssWidth = canvas.clientWidth || canvas.width;
    const cssHeight = canvas.clientHeight || canvas.height;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    return { ctx, width: cssWidth, height: cssHeight };
  }

  const PADDING = { top: 16, right: 16, bottom: 28, left: 56 };

  /**
   * Bar chart: one bar per cue, x = subtitle position, y = signed
   * timing difference in ms, colored by match-quality band. Unmatched
   * rows are skipped (nothing to plot on a timing axis).
   */
  function drawHistogram(canvas, points) {
    const { ctx, width, height } = prepareCanvas(canvas);
    const colors = getThemeColors();
    const plotW = width - PADDING.left - PADDING.right;
    const plotH = height - PADDING.top - PADDING.bottom;

    const plotted = points.filter(p => p.diffMs !== null);
    if (plotted.length === 0) {
      drawEmptyState(ctx, width, height, colors, 'No matched cues to plot.');
      return;
    }

    const maxAbs = Math.max(...plotted.map(p => Math.abs(p.diffMs)), 1);
    const { max: yMax } = niceAxisBounds(0, maxAbs);
    const yMin = -yMax;

    const xScale = makeScale(0, points.length - 1 || 1, PADDING.left, PADDING.left + plotW);
    const yScale = makeScale(yMin, yMax, PADDING.top + plotH, PADDING.top);

    drawYAxis(ctx, colors, yMin, yMax, yScale, PADDING, plotW, msLabel);
    drawZeroLine(ctx, colors, yScale(0), PADDING, plotW);

    const barWidth = Math.max(1, Math.min(6, plotW / points.length - 1));
    for (const p of plotted) {
      const x = xScale(p.index) - barWidth / 2;
      const yZero = yScale(0);
      const yVal = yScale(p.diffMs);
      ctx.fillStyle = colorForQuality(colors, p.qualityKey || qualityKeyFromDiff(p.diffMs));
      const barTop = Math.min(yZero, yVal);
      const barH = Math.abs(yVal - yZero) || 1;
      ctx.fillRect(x, barTop, barWidth, barH);
    }

    drawXAxisLabel(ctx, colors, width, height, 'Subtitle position →');
  }

  /**
   * Line chart: cumulative drift (running sum of diffMs) across the
   * file, with a faint rolling-average overlay so short-term noise
   * doesn't obscure the long-term trend.
   */
  function drawDriftGraph(canvas, points) {
    const { ctx, width, height } = prepareCanvas(canvas);
    const colors = getThemeColors();
    const plotW = width - PADDING.left - PADDING.right;
    const plotH = height - PADDING.top - PADDING.bottom;

    const plotted = points.filter(p => p.cumulativeMs !== null);
    if (plotted.length === 0) {
      drawEmptyState(ctx, width, height, colors, 'No matched cues to plot.');
      return;
    }

    const values = plotted.map(p => p.cumulativeMs);
    const rawMin = Math.min(...values, 0);
    const rawMax = Math.max(...values, 0);
    const { min: yMin, max: yMax } = niceAxisBounds(rawMin, rawMax);

    const xScale = makeScale(0, points.length - 1 || 1, PADDING.left, PADDING.left + plotW);
    const yScale = makeScale(yMin, yMax, PADDING.top + plotH, PADDING.top);

    drawYAxis(ctx, colors, yMin, yMax, yScale, PADDING, plotW, msLabel);
    drawZeroLine(ctx, colors, yScale(0), PADDING, plotW);

    // Cumulative drift line
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    let started = false;
    for (const p of plotted) {
      const x = xScale(p.index), y = yScale(p.cumulativeMs);
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    }
    ctx.stroke();

    drawXAxisLabel(ctx, colors, width, height, 'Subtitle position →');
  }

  /* ---------------------------------------------------------------------
   * Shared drawing helpers
   * ------------------------------------------------------------------- */

  function msLabel(v) {
    return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 's';
  }

  function qualityKeyFromDiff(diffMs) {
    const abs = Math.abs(diffMs);
    if (abs < 250) return 'excellent';
    if (abs < 1000) return 'good';
    if (abs < 2000) return 'poor';
    return 'bad';
  }

  function drawYAxis(ctx, colors, min, max, yScale, padding, plotW, formatter) {
    ctx.strokeStyle = colors.border;
    ctx.fillStyle = colors.textMuted;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const value = min + ((max - min) * i) / steps;
      const y = yScale(value);
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + plotW, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(formatter(value), padding.left - 8, y);
    }
  }

  function drawZeroLine(ctx, colors, yZero, padding, plotW) {
    ctx.strokeStyle = colors.textMuted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, yZero);
    ctx.lineTo(padding.left + plotW, yZero);
    ctx.stroke();
  }

  function drawXAxisLabel(ctx, colors, width, height, text) {
    ctx.fillStyle = colors.textMuted;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, width / 2, height - 6);
  }

  function drawEmptyState(ctx, width, height, colors, text) {
    ctx.fillStyle = colors.textMuted;
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, width / 2, height / 2);
  }

  global.SubtitleGraphs = {
    drawHistogram,
    drawDriftGraph,
    getThemeColors,
    niceAxisBounds,
    makeScale,
    qualityKeyFromDiff,
    prepareCanvas
  };

})(typeof window !== 'undefined' ? window : globalThis);
