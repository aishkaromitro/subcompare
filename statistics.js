/* ==========================================================================
   statistics.js
   Responsibility: turn aligned rows (from alignment.js/dtw.js) into the
   numbers the UI needs — per-row timing metrics, the summary stats
   panel, graph data, and the plain-English suggestions ("Subtitle B
   appears to be delayed by 1.42 seconds").

   Terminology note (since the brief lists several related-sounding
   metrics): 
     - diffMs            = signed timing difference for ONE row (b - a)
     - average/median offset = mean/median of diffMs across matched rows
     - rolling average offset = diffMs smoothed with a moving window,
                                 i.e. the local trend at each point
     - cumulative drift   = running SUM of diffMs up to each row, which
                             makes a steadily-growing or shrinking trend
                             visually obvious even when per-row diffMs
                             is noisy — this is what the "cumulative
                             drift graph" plots.
   ========================================================================== */

(function (global) {
  'use strict';

  const QUALITY_THRESHOLDS = [
    { max: 250, key: 'excellent', label: 'Excellent' },
    { max: 1000, key: 'good', label: 'Good' },
    { max: 2000, key: 'poor', label: 'Poor' },
    { max: Infinity, key: 'bad', label: 'Bad' }
  ];

  function qualityFor(diffMs) {
    if (diffMs === null || diffMs === undefined) return { key: 'none', label: 'No match' };
    const abs = Math.abs(diffMs);
    for (const t of QUALITY_THRESHOLDS) {
      if (abs < t.max) return { key: t.key, label: t.label };
    }
    return { key: 'bad', label: 'Bad' };
  }

  /**
   * Annotates each alignment row with diffMs, quality, and pre-computed
   * diff HTML for both sides. Mutates and returns the same array for
   * convenience (rows are already freshly built by the aligner, so this
   * is safe and avoids a second full-array copy for large files).
   */
  function annotateRows(rows) {
    for (const row of rows) {
      if (row.a && row.b) {
        row.diffMs = row.b.startMs - row.a.startMs;
        row.quality = qualityFor(row.diffMs);
        const { htmlA, htmlB } = global.SubtitleDiff.renderDiffHtml(row.a.text, row.b.text);
        row.htmlA = htmlA;
        row.htmlB = htmlB;
        row.textDiff = global.SubtitleDiff.diffSummary(row.a.text, row.b.text);
      } else {
        row.diffMs = null;
        row.quality = qualityFor(null);
        row.htmlA = row.a ? escapeHtml(row.a.text) : '';
        row.htmlB = row.b ? escapeHtml(row.b.text) : '';
        row.textDiff = { inserted: 0, removed: 0, changed: 0, hasDifference: false };
      }
    }
    return rows;
  }

  function escapeHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function mean(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }

  function median(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  function stdDev(arr, avg) {
    if (arr.length < 2) return 0;
    const m = avg !== undefined ? avg : mean(arr);
    const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
  }

  /** Ordinary least squares fit of y = slope*x + intercept. */
  function linearRegression(xs, ys) {
    const n = xs.length;
    if (n < 2) return { slope: 0, intercept: n === 1 ? ys[0] : 0 };
    const xMean = mean(xs), yMean = mean(ys);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - xMean) * (ys[i] - yMean);
      den += (xs[i] - xMean) ** 2;
    }
    const slope = den === 0 ? 0 : num / den;
    const intercept = yMean - slope * xMean;
    return { slope, intercept };
  }

  /**
   * Computes the headline stats panel numbers.
   * @param {Array} rows - annotated rows
   * @param {number} countA - total cues originally in file A
   * @param {number} countB - total cues originally in file B
   */
  function computeStatistics(rows, countA, countB) {
    const matched = rows.filter(r => r.a && r.b);
    const unmatched = rows.length - matched.length;
    const diffs = matched.map(r => r.diffMs);
    const absDiffs = diffs.map(Math.abs);

    return {
      countA,
      countB,
      matchedCount: matched.length,
      unmatchedCount: unmatched,
      averageOffsetMs: mean(diffs),
      medianOffsetMs: median(diffs),
      maxDiffMs: absDiffs.length ? Math.max(...absDiffs) : 0,
      stdDevMs: stdDev(diffs)
    };
  }

  /**
   * Builds the two graph datasets: per-row diff (histogram) and
   * cumulative drift (running sum), plus a rolling average overlay.
   */
  function computeGraphData(rows, rollingWindow) {
    const window = rollingWindow || 15;
    const points = [];
    let cumulative = 0;
    const recentBuffer = [];

    rows.forEach((row, idx) => {
      const diff = row.diffMs; // null for unmatched rows
      if (diff !== null) {
        cumulative += diff;
        recentBuffer.push(diff);
        if (recentBuffer.length > window) recentBuffer.shift();
      }
      const rollingAvg = recentBuffer.length ? mean(recentBuffer) : null;
      points.push({
        index: idx,
        diffMs: diff,
        cumulativeMs: diff !== null ? cumulative : null,
        rollingAvgMs: rollingAvg
      });
    });

    return points;
  }

  /* ---------------------------------------------------------------------
   * Pattern detection
   * ------------------------------------------------------------------- */

  // Common frame-rate pairs, expressed as the ratio a timestamp would be
  // multiplied by when converted from one to the other.
  const FPS_PAIRS = [
    [23.976, 25], [25, 23.976],
    [24, 25], [25, 24],
    [23.976, 24], [24, 23.976],
    [29.97, 25], [25, 29.97],
    [29.97, 30], [30, 29.97],
    [24, 29.97], [29.97, 24]
  ];

  function detectPatterns(rows, stats) {
    const suggestions = [];
    const matched = rows.filter(r => r.a && r.b);
    if (matched.length < 3) return suggestions;

    const { averageOffsetMs, stdDevMs } = stats;

    // 1) Constant shift: low variance around a non-trivial average offset.
    const isConstantShift = Math.abs(averageOffsetMs) > 200 && stdDevMs < Math.max(150, Math.abs(averageOffsetMs) * 0.25);
    if (isConstantShift) {
      const seconds = Math.abs(averageOffsetMs) / 1000;
      const direction = averageOffsetMs > 0 ? 'delayed' : 'ahead of Subtitle A';
      suggestions.push(
        averageOffsetMs > 0
          ? `Subtitle B appears to be delayed by ${seconds.toFixed(2)} seconds relative to Subtitle A.`
          : `Subtitle B appears to be ${seconds.toFixed(2)} seconds ahead of Subtitle A.`
      );
    }

    // 2) FPS conversion: fit startB = slope*startA + intercept and check
    // whether the slope lands near a known frame-rate conversion ratio.
    const xs = matched.map(r => r.a.startMs);
    const ys = matched.map(r => r.b.startMs);
    const { slope } = linearRegression(xs, ys);
    // Only worth checking against the FPS table once the slope has
    // drifted meaningfully from 1.0 — some real FPS pairs (23.976 vs 24)
    // are so close to a no-op ratio that ordinary jitter/noise alone can
    // land inside a naive tolerance band and produce a false positive.
    const slopeDeviatesEnough = Math.abs(slope - 1) > 0.003;
    if (slopeDeviatesEnough) {
      for (const [fromFps, toFps] of FPS_PAIRS) {
        const ratio = toFps / fromFps;
        if (Math.abs(ratio - 1) < 0.003) continue; // too close to a no-op to be distinguishable
        if (Math.abs(slope - ratio) < 0.004) {
          suggestions.push(
            `The timing looks like a frame-rate conversion issue — consistent with a ${fromFps} → ${toFps} fps mismatch (scale factor ≈ ${ratio.toFixed(4)}).`
          );
          break;
        }
      }
    }

    // 3) Growing drift: slope far from 1.0 but not matching a clean FPS
    // ratio, and not explained by a constant shift — timing is
    // stretching/compressing across the file.
    const explainedByFps = suggestions.some(s => s.includes('frame-rate'));
    if (!explainedByFps && !isConstantShift && Math.abs(slope - 1) > 0.0015) {
      const direction = slope > 1 ? 'growing' : 'shrinking';
      suggestions.push(
        `Timing drift appears to be ${direction} across the file (not a simple constant offset) — Subtitle B's timestamps scale by a factor of about ${slope.toFixed(4)}× relative to Subtitle A's.`
      );
    }

    return suggestions;
  }

  global.SubtitleStats = {
    qualityFor,
    annotateRows,
    computeStatistics,
    computeGraphData,
    detectPatterns,
    mean,
    median,
    stdDev,
    linearRegression
  };

})(typeof window !== 'undefined' ? window : globalThis);
