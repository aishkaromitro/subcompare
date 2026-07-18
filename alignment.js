/* ==========================================================================
   alignment.js
   Responsibility: turn two cue arrays (from parser.js) into a single list
   of aligned ROWS: { a: cueOrNull, b: cueOrNull }. Never uses cue.index —
   only startMs/endMs — per the "compare by timecode" requirement.

   Two of the three alignment modes live here:
     - alignNearest   (Mode 1)
     - alignMonotonic (Mode 2, dynamic programming)
   Mode 3 (DTW) lives in dtw.js and is merged into this module's public
   API via ALIGNERS so ui.js/app.js only ever call Alignment.align(mode,...).
   ========================================================================== */

(function (global) {
  'use strict';

  /* ---------------------------------------------------------------------
   * Mode 1 — Nearest timestamp
   * For every cue in A, find the closest-start-time cue in B (and vice
   * versa for anything in B left unmatched), independently. Fast (O(n log n)
   * via a two-pointer sweep since both arrays are start-time sorted) but
   * can produce crossed/duplicate matches — that's expected, it's the
   * "quick and dirty" mode.
   * ------------------------------------------------------------------- */
  function alignNearest(cuesA, cuesB, options) {
    const opts = options || {};
    // Hard cutoff: a candidate match farther apart than this is never
    // accepted, no matter how close it is relative to other candidates —
    // this is what lets a cue genuinely absent from the other file (e.g.
    // it only covers part of the timeline) end up correctly unmatched
    // instead of force-paired to whatever's nearest.
    const maxVarianceMs = (opts.maxVarianceMs != null && opts.maxVarianceMs >= 0) ? opts.maxVarianceMs : null;

    const rows = [];
    const usedB = new Set();

    // Two-pointer nearest search: for each A cue, walk a moving window
    // in B rather than scanning the whole array every time.
    let bPointer = 0;
    for (let i = 0; i < cuesA.length; i++) {
      const a = cuesA[i];
      // advance bPointer while the NEXT b is still closer than current
      while (
        bPointer < cuesB.length - 1 &&
        Math.abs(cuesB[bPointer + 1].startMs - a.startMs) <= Math.abs(cuesB[bPointer].startMs - a.startMs)
      ) {
        bPointer++;
      }
      const nearest = cuesB.length > 0 ? cuesB[bPointer] : null;
      const withinVariance = nearest && (maxVarianceMs === null || Math.abs(nearest.startMs - a.startMs) <= maxVarianceMs);
      if (withinVariance) {
        usedB.add(nearest);
        rows.push({ a, b: nearest });
      } else {
        rows.push({ a, b: null });
      }
    }

    // Any B cues nobody claimed get their own unmatched row, inserted in
    // time order via a merge-by-start-time pass at the end.
    const unmatchedB = cuesB.filter(b => !usedB.has(b));
    for (const b of unmatchedB) rows.push({ a: null, b });

    rows.sort((r1, r2) => {
      const t1 = r1.a ? r1.a.startMs : r1.b.startMs;
      const t2 = r2.a ? r2.a.startMs : r2.b.startMs;
      return t1 - t2;
    });
    return rows;
  }

  /* ---------------------------------------------------------------------
   * Mode 2 — Monotonic alignment via Dynamic Programming
   * This is the classic "sequence alignment" DP (same family as the
   * Needleman-Wunsch algorithm used for diffing/bioinformatics),
   * specialized so that matched pairs always advance in order: once we
   * match A[i] with B[j], any future match must use A[i'>i], B[j'>j].
   * That guarantees the "never match backwards" requirement.
   *
   * Complexity: O(n*m) time and space. For the stated 10,000 x 10,000
   * worst case that's 100,000,000 cells — too much for a plain 2D array
   * in a browser tab. We therefore band the DP: only cells within
   * MAX_BAND index-positions of the diagonal are considered, since two
   * subtitle files that genuinely correspond will never need a match
   * thousands of entries away from the "expected" position. This keeps
   * real-world use fast while staying correct for the common case.
   * ------------------------------------------------------------------- */
  function alignMonotonic(cuesA, cuesB, options) {
    const n = cuesA.length;
    const m = cuesB.length;
    const opts = options || {};
    // Band width scales with size difference so genuinely misaligned
    // files (many missing entries) still get a fair search window.
    const band = Math.max(
      opts.band || 300,
      Math.abs(n - m) + 50
    );

    const GAP_COST = opts.gapCost || 4000; // cost of leaving a cue unmatched (ms-equivalent)
    // Hard cutoff, separate from GAP_COST: GAP_COST only makes skipping
    // *preferable* once a match gets expensive enough — a match costing
    // just under GAP_COST would still win. maxVarianceMs instead makes a
    // match past this distance flatly ineligible, regardless of GAP_COST.
    const maxVarianceMs = (opts.maxVarianceMs != null && opts.maxVarianceMs >= 0) ? opts.maxVarianceMs : null;
    const INF = Infinity;

    // matchCost(i, j): how good is it to pair cuesA[i] with cuesB[j]?
    // Lower is better. Based purely on timing (text isn't used at this
    // stage — diff.js handles text after alignment is decided).
    function matchCost(i, j) {
      const diff = Math.abs(cuesA[i].startMs - cuesB[j].startMs);
      if (maxVarianceMs !== null && diff > maxVarianceMs) return INF;
      return diff;
    }

    // dp[i][j] stored as a band-limited map for memory efficiency:
    // dp[i] is an object keyed by j (only j within band of i).
    const dp = new Array(n + 1);
    const choice = new Array(n + 1); // 'match' | 'skipA' | 'skipB', for traceback

    for (let i = 0; i <= n; i++) {
      dp[i] = new Map();
      choice[i] = new Map();
    }
    dp[0].set(0, 0);

    for (let i = 0; i <= n; i++) {
      const jCenter = m === 0 ? 0 : Math.round((i / Math.max(n, 1)) * m);
      const jLo = Math.max(0, jCenter - band);
      const jHi = Math.min(m, jCenter + band);

      for (let j = jLo; j <= jHi; j++) {
        if (i === 0 && j === 0) continue;

        let best = INF;
        let bestChoice = null;

        // Option 1: match cuesA[i-1] with cuesB[j-1]
        if (i > 0 && j > 0 && dp[i - 1].has(j - 1)) {
          const cost = dp[i - 1].get(j - 1) + matchCost(i - 1, j - 1);
          if (cost < best) { best = cost; bestChoice = 'match'; }
        }
        // Option 2: skip cuesA[i-1] (unmatched A)
        if (i > 0 && dp[i - 1].has(j)) {
          const cost = dp[i - 1].get(j) + GAP_COST;
          if (cost < best) { best = cost; bestChoice = 'skipA'; }
        }
        // Option 3: skip cuesB[j-1] (unmatched B)
        if (j > 0 && dp[i].has(j - 1)) {
          const cost = dp[i].get(j - 1) + GAP_COST;
          if (cost < best) { best = cost; bestChoice = 'skipB'; }
        }

        if (bestChoice) {
          dp[i].set(j, best);
          choice[i].set(j, bestChoice);
        }
      }
    }

    // Find the best endpoint near (n, m) — with banding, (n,m) itself
    // might have been outside the search window in pathological cases,
    // so fall back to scanning row n for the lowest-cost j.
    let endJ = m;
    if (!dp[n].has(m)) {
      let bestCost = INF;
      for (const [j, cost] of dp[n].entries()) {
        if (cost < bestCost) { bestCost = cost; endJ = j; }
      }
    }

    // Traceback
    const rows = [];
    let i = n, j = endJ;
    while (i > 0 || j > 0) {
      const c = choice[i] && choice[i].get(j);
      if (c === 'match') {
        rows.push({ a: cuesA[i - 1], b: cuesB[j - 1] });
        i--; j--;
      } else if (c === 'skipA') {
        rows.push({ a: cuesA[i - 1], b: null });
        i--;
      } else if (c === 'skipB') {
        rows.push({ a: null, b: cuesB[j - 1] });
        j--;
      } else {
        // Shouldn't happen if DP ran fully, but guard against band
        // edge cases by dumping remaining cues as unmatched rather
        // than looping forever.
        if (i > 0) { rows.push({ a: cuesA[i - 1], b: null }); i--; }
        else if (j > 0) { rows.push({ a: null, b: cuesB[j - 1] }); j--; }
      }
    }
    rows.reverse();
    return rows;
  }

  /* ---------------------------------------------------------------------
   * Public API — dispatches to whichever mode is requested. dtw.js
   * registers itself into ALIGNERS.dtw when it loads (script order in
   * index.html guarantees dtw.js loads before this is ever called).
   * ------------------------------------------------------------------- */
  const ALIGNERS = {
    nearest: alignNearest,
    monotonic: alignMonotonic
  };

  function align(mode, cuesA, cuesB, options) {
    const fn = ALIGNERS[mode];
    if (!fn) throw new Error(`Unknown alignment mode "${mode}".`);
    return fn(cuesA, cuesB, options);
  }

  function registerAligner(mode, fn) {
    ALIGNERS[mode] = fn;
  }

  global.Alignment = {
    align,
    registerAligner,
    alignNearest,
    alignMonotonic
  };

})(typeof window !== 'undefined' ? window : globalThis);
