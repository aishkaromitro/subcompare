/* ==========================================================================
   dtw.js
   Responsibility: Mode 3 — Dynamic Time Warping alignment.

   Design note on "full DTW": textbook DTW has no gap penalty — every
   element of both sequences must appear in the warping path, produced
   purely from {diagonal, up, left} steps. Applied naively to subtitles
   that don't cover the same time range (e.g. B is missing a 40-cue
   chunk), that forces bad matches rather than leaving cues unmatched.
   So this implementation is DTW's warping recurrence PLUS the option to
   skip a cue at a fixed gap cost — i.e. DTW's rich multi-factor cost
   function (not just a scalar distance) combined with monotonic.js's
   tolerance for missing entries. This is the practical form of DTW used
   in subtitle/audio sync tools, and is documented here so the choice is
   explicit rather than silently different from the algorithms literature.

   Like alignment.js's monotonic mode, this is banded for performance:
   full O(n*m) DTW over two 10,000-cue files is 100M cells, which is not
   practical in a browser tab.
   ========================================================================== */

(function (global) {
  'use strict';

  /**
   * Multi-factor DTW cost between cue a and cue b, per the spec:
   * start time difference, end time difference, duration difference,
   * and overlap percentage.
   * @returns {number} lower = better match
   */
  function dtwCost(a, b, weights) {
    const w = weights || DEFAULT_WEIGHTS;

    const startDiff = Math.abs(a.startMs - b.startMs);
    const endDiff = Math.abs(a.endMs - b.endMs);

    const durA = a.endMs - a.startMs;
    const durB = b.endMs - b.startMs;
    const durationDiff = Math.abs(durA - durB);

    const overlapStart = Math.max(a.startMs, b.startMs);
    const overlapEnd = Math.min(a.endMs, b.endMs);
    const overlapMs = Math.max(0, overlapEnd - overlapStart);
    const unionStart = Math.min(a.startMs, b.startMs);
    const unionEnd = Math.max(a.endMs, b.endMs);
    const unionMs = Math.max(1, unionEnd - unionStart); // avoid /0
    const overlapPct = overlapMs / unionMs; // 0..1, higher = better
    const overlapPenalty = (1 - overlapPct) * w.overlapScale;

    return (
      w.startDiff * startDiff +
      w.endDiff * endDiff +
      w.durationDiff * durationDiff +
      w.overlap * overlapPenalty
    );
  }

  const DEFAULT_WEIGHTS = {
    startDiff: 1.0,
    endDiff: 0.5,
    durationDiff: 0.3,
    overlap: 1.0,
    overlapScale: 1000 // scales the 0..1 overlap penalty into ms-comparable units
  };

  /**
   * Banded DTW with gap-skip fallback. Same dp[i] = Map<j, cost> shape
   * as alignment.js's alignMonotonic, for consistency and so the two
   * are easy to compare/maintain side by side.
   */
  function alignDTW(cuesA, cuesB, options) {
    const n = cuesA.length;
    const m = cuesB.length;
    const opts = options || {};
    const band = Math.max(opts.band || 300, Math.abs(n - m) + 50);
    const GAP_COST = opts.gapCost || 4000;
    const weights = opts.weights || DEFAULT_WEIGHTS;
    // Hard cutoff on start-time distance, same contract as alignment.js's
    // alignNearest/alignMonotonic: a candidate match farther apart than
    // this is never chosen, regardless of how favorable dtwCost's other
    // factors (duration/overlap) make it look.
    const maxVarianceMs = (opts.maxVarianceMs != null && opts.maxVarianceMs >= 0) ? opts.maxVarianceMs : null;
    const INF = Infinity;

    const dp = new Array(n + 1);
    const choice = new Array(n + 1);
    for (let i = 0; i <= n; i++) { dp[i] = new Map(); choice[i] = new Map(); }
    dp[0].set(0, 0);

    for (let i = 0; i <= n; i++) {
      const jCenter = m === 0 ? 0 : Math.round((i / Math.max(n, 1)) * m);
      const jLo = Math.max(0, jCenter - band);
      const jHi = Math.min(m, jCenter + band);

      for (let j = jLo; j <= jHi; j++) {
        if (i === 0 && j === 0) continue;
        let best = INF, bestChoice = null;

        if (i > 0 && j > 0 && dp[i - 1].has(j - 1)) {
          const a = cuesA[i - 1], b = cuesB[j - 1];
          const withinVariance = maxVarianceMs === null || Math.abs(a.startMs - b.startMs) <= maxVarianceMs;
          const cost = withinVariance ? dp[i - 1].get(j - 1) + dtwCost(a, b, weights) : INF;
          if (cost < best) { best = cost; bestChoice = 'match'; }
        }
        if (i > 0 && dp[i - 1].has(j)) {
          const cost = dp[i - 1].get(j) + GAP_COST;
          if (cost < best) { best = cost; bestChoice = 'skipA'; }
        }
        if (j > 0 && dp[i].has(j - 1)) {
          const cost = dp[i].get(j - 1) + GAP_COST;
          if (cost < best) { best = cost; bestChoice = 'skipB'; }
        }

        if (bestChoice) { dp[i].set(j, best); choice[i].set(j, bestChoice); }
      }
    }

    let endJ = m;
    if (!dp[n].has(m)) {
      let bestCost = INF;
      for (const [j, cost] of dp[n].entries()) {
        if (cost < bestCost) { bestCost = cost; endJ = j; }
      }
    }

    const rows = [];
    let i = n, j = endJ;
    while (i > 0 || j > 0) {
      const c = choice[i] && choice[i].get(j);
      if (c === 'match') { rows.push({ a: cuesA[i - 1], b: cuesB[j - 1] }); i--; j--; }
      else if (c === 'skipA') { rows.push({ a: cuesA[i - 1], b: null }); i--; }
      else if (c === 'skipB') { rows.push({ a: null, b: cuesB[j - 1] }); j--; }
      else {
        if (i > 0) { rows.push({ a: cuesA[i - 1], b: null }); i--; }
        else if (j > 0) { rows.push({ a: null, b: cuesB[j - 1] }); j--; }
      }
    }
    rows.reverse();
    return rows;
  }

  // Register into the shared Alignment dispatcher from alignment.js.
  // (index.html loads alignment.js before dtw.js, so global.Alignment
  // is guaranteed to exist here.)
  global.Alignment.registerAligner('dtw', alignDTW);
  global.DTW = { alignDTW, dtwCost, DEFAULT_WEIGHTS };

})(typeof window !== 'undefined' ? window : globalThis);
