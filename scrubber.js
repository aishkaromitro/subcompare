/* ==========================================================================
   scrubber.js
   Responsibility: a clickable/draggable vertical time axis rendered next
   to the comparison table — a compressed view of the WHOLE file's time
   range (independent of the current search/filter, so it doesn't rescale
   as filters change) with a tick + label every 30 minutes, plus a
   highlighted band showing which slice of that range is currently
   scrolled into view. app.js owns translating clicks into an actual
   table scroll position; this module only does the math and the
   drawing.

   Same "Canvas API only, no chart libraries" constraint as graphs.js,
   and reuses its prepareCanvas/getThemeColors helpers rather than
   duplicating DPI-scaling/theme-reading logic.

   Pure math (rowTime, computeDomain, timeAtY, yAtTime, nearestRowIndex)
   is separated from draw() so it's testable without a real <canvas>.
   ========================================================================== */

(function (global) {
  'use strict';

  const THIRTY_MIN_MS = 30 * 60 * 1000;

  /** A row's position on the timeline — whichever side has a cue. */
  function rowTime(row) {
    if (row.a) return row.a.startMs;
    if (row.b) return row.b.startMs;
    return null;
  }

  /**
   * Time span the axis should cover, rounded up to the next 30-minute
   * boundary so the top tick always lands cleanly, with a floor so a
   * very short file still gets a usable axis.
   */
  function computeDomain(rows) {
    let maxMs = 0;
    for (const row of rows) {
      const t = rowTime(row);
      if (t !== null && t > maxMs) maxMs = t;
    }
    return Math.max(THIRTY_MIN_MS, Math.ceil(maxMs / THIRTY_MIN_MS) * THIRTY_MIN_MS);
  }

  function formatTick(ms) {
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  /** pixel y (0 = top) -> time in ms, given the track height and domain span. */
  function timeAtY(y, height, domainMax) {
    if (height <= 0) return 0;
    const clampedY = Math.max(0, Math.min(height, y));
    return (clampedY / height) * domainMax;
  }

  /** time in ms -> pixel y, inverse of timeAtY. */
  function yAtTime(ms, height, domainMax) {
    if (domainMax === 0) return 0;
    return (ms / domainMax) * height;
  }

  /**
   * Index (into `rows`) whose time is closest to `targetMs`. `rows` is
   * whatever's currently rendered in the table — rows with no usable
   * time are skipped. Returns -1 if none has a usable time.
   */
  function nearestRowIndex(rows, targetMs) {
    let bestIdx = -1;
    let bestDist = Infinity;
    rows.forEach((row, idx) => {
      const t = rowTime(row);
      if (t === null) return;
      const dist = Math.abs(t - targetMs);
      if (dist < bestDist) { bestDist = dist; bestIdx = idx; }
    });
    return bestIdx;
  }

  /**
   * Draws the track: 30-minute gridlines + labels, and an optional band
   * highlighting the time range currently visible in the table.
   * @param {HTMLCanvasElement} canvas
   * @param {number} domainMax - from computeDomain()
   * @param {{startMs:number, endMs:number}|null} viewport
   */
  function draw(canvas, domainMax, viewport) {
    const G = global.SubtitleGraphs;
    const { ctx, width, height } = G.prepareCanvas(canvas);
    const colors = G.getThemeColors();

    ctx.fillStyle = colors.border;
    ctx.globalAlpha = 0.25;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = 1;

    if (viewport) {
      const y0 = yAtTime(viewport.startMs, height, domainMax);
      const y1 = yAtTime(viewport.endMs, height, domainMax);
      ctx.fillStyle = colors.accent;
      ctx.globalAlpha = 0.22;
      ctx.fillRect(0, y0, width, Math.max(3, y1 - y0));
      ctx.globalAlpha = 1;
    }

    ctx.strokeStyle = colors.border;
    ctx.fillStyle = colors.textMuted;
    ctx.font = '9px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 1;

    for (let t = 0; t <= domainMax; t += THIRTY_MIN_MS) {
      const y = yAtTime(t, height, domainMax);
      const lineY = Math.min(Math.round(y) + 0.5, height - 0.5);
      ctx.beginPath();
      ctx.moveTo(0, lineY);
      ctx.lineTo(width, lineY);
      ctx.stroke();
      ctx.fillText(formatTick(t), 3, Math.min(y + 2, height - 10));
    }
  }

  global.SubtitleScrubber = {
    THIRTY_MIN_MS,
    rowTime,
    computeDomain,
    formatTick,
    timeAtY,
    yAtTime,
    nearestRowIndex,
    draw
  };

})(typeof window !== 'undefined' ? window : globalThis);
