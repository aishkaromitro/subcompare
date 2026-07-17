/* ==========================================================================
   diff.js
   Responsibility: word-level diffing of two subtitle text strings, for
   rendering inserted/removed/changed words after alignment has already
   decided which A cue pairs with which B cue. This module never touches
   timing — it only ever receives two strings.

   Algorithm: classic LCS (longest common subsequence) over word tokens,
   which is the standard basis for word-level diff tools. Subtitle lines
   are short (a handful of words), so the O(n*m) LCS table is trivial —
   no need for anything fancier like Myers' O(ND) here.
   ========================================================================== */

(function (global) {
  'use strict';

  /**
   * Splits text into tokens, keeping whitespace as its own token so the
   * original spacing can be reconstructed exactly. Newlines (from
   * multi-line cues) are preserved as tokens too.
   */
  function tokenize(text) {
    if (!text) return [];
    return text.split(/(\s+)/).filter(t => t.length > 0);
  }

  /**
   * Computes a word-level diff between two strings.
   * @returns {Array<{type: 'equal'|'insert'|'delete', value: string}>}
   *          A sequence that, if you concatenate the 'equal'+'delete'
   *          values, reconstructs `textA`; 'equal'+'insert' reconstructs
   *          `textB`.
   */
  function diffWords(textA, textB) {
    const a = tokenize(textA);
    const b = tokenize(textB);
    const n = a.length, m = b.length;

    // LCS length table
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        lcs[i][j] = (a[i - 1] === b[j - 1])
          ? lcs[i - 1][j - 1] + 1
          : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      }
    }

    // Backtrack to build the opcode sequence, then reverse.
    const ops = [];
    let i = n, j = m;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        ops.push({ type: 'equal', value: a[i - 1] });
        i--; j--;
      } else if (lcs[i - 1][j] >= lcs[i][j - 1]) {
        ops.push({ type: 'delete', value: a[i - 1] });
        i--;
      } else {
        ops.push({ type: 'insert', value: b[j - 1] });
        j--;
      }
    }
    while (i > 0) { ops.push({ type: 'delete', value: a[i - 1] }); i--; }
    while (j > 0) { ops.push({ type: 'insert', value: b[j - 1] }); j--; }
    ops.reverse();

    // Merge adjacent same-type ops (mostly relevant after whitespace
    // tokens are folded back in) for a cleaner op list.
    const merged = [];
    for (const op of ops) {
      const last = merged[merged.length - 1];
      if (last && last.type === op.type) last.value += op.value;
      else merged.push({ ...op });
    }
    return merged;
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Renders the diff as two HTML strings: one for the "A" side (equal +
   * delete, i.e. what's unique to / removed from A) and one for the "B"
   * side (equal + insert). A run of delete immediately followed by
   * insert (or vice versa) is treated as a "changed" word for styling
   * purposes but rendered as a delete+insert pair, which is the
   * conventional and most legible way to show a word-level change.
   */
  function renderDiffHtml(textA, textB) {
    const ops = diffWords(textA, textB);
    let htmlA = '';
    let htmlB = '';
    for (const op of ops) {
      const safe = escapeHtml(op.value);
      if (op.type === 'equal') {
        htmlA += safe;
        htmlB += safe;
      } else if (op.type === 'delete') {
        htmlA += `<del class="diff-del">${safe}</del>`;
      } else if (op.type === 'insert') {
        htmlB += `<ins class="diff-ins">${safe}</ins>`;
      }
    }
    return { htmlA, htmlB };
  }

  /**
   * Summary counts used by statistics.js / the "text differences" filter:
   * how many words were inserted, removed, and how many equal-length
   * adjacent delete+insert runs look like a "changed" word vs. a pure
   * insertion/deletion.
   */
  function diffSummary(textA, textB) {
    const ops = diffWords(textA, textB).filter(o => o.type !== 'equal' || o.value.trim() !== '');
    let inserted = 0, removed = 0, changed = 0;
    for (let k = 0; k < ops.length; k++) {
      const op = ops[k];
      if (op.type === 'equal') continue;
      const next = ops[k + 1];
      // A delete immediately next to an insert (in either order) reads
      // as one word being swapped for another, not an independent
      // addition + removal.
      if (next && ((op.type === 'delete' && next.type === 'insert') || (op.type === 'insert' && next.type === 'delete'))) {
        changed++;
        k++; // consume the paired op
      } else if (op.type === 'delete') {
        removed++;
      } else if (op.type === 'insert') {
        inserted++;
      }
    }
    const identical = textA.trim() === textB.trim();
    return { inserted, removed, changed, hasDifference: !identical && ops.length > 0 };
  }

  global.SubtitleDiff = { tokenize, diffWords, renderDiffHtml, diffSummary };

})(typeof window !== 'undefined' ? window : globalThis);
