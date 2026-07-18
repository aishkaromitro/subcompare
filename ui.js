/* ==========================================================================
   ui.js
   Responsibility: DOM rendering + interaction for everything below the
   upload panel — stats grid, table body, search, filter chips, column
   sorting, row highlighting. Owns no algorithms (those live in
   alignment/dtw/diff/statistics.js) and owns no file I/O (that's
   app.js) — it only ever receives already-computed rows/stats and
   renders them, or reports back what the user typed/clicked.

   Pure logic (filterRows, searchMatches, sortRows) is separated from
   the DOM-touching render* functions so it can be unit tested without
   a browser.
   ========================================================================== */

(function (global) {
  'use strict';

  /* ---------------------------------------------------------------------
   * Pure logic: filtering, searching, sorting
   * ------------------------------------------------------------------- */

  const FILTERS = {
    all: () => true,
    mismatches: row => row.quality && row.quality.key !== 'excellent',
    missing: row => !row.a || !row.b,
    timing: row => row.diffMs !== null && Math.abs(row.diffMs) >= 250,
    textdiff: row => row.textDiff && row.textDiff.hasDifference
  };

  function filterRows(rows, filterKey, thresholdMs) {
    const fn = FILTERS[filterKey] || FILTERS.all;
    let result = rows.filter(fn);
    if (thresholdMs && thresholdMs > 0) {
      result = result.filter(row => row.diffMs !== null && Math.abs(row.diffMs) >= thresholdMs);
    }
    return result;
  }

  /**
   * Case-insensitive search across both subtitle texts and both
   * timestamps. Returns the subset of rows that match, in original
   * order.
   */
  function searchRows(rows, query) {
    if (!query || !query.trim()) return rows;
    const q = query.trim().toLowerCase();
    return rows.filter(row => {
      const textA = row.a ? row.a.text.toLowerCase() : '';
      const textB = row.b ? row.b.text.toLowerCase() : '';
      const timeA = row.a ? global.SubtitleParser.msToTime(row.a.startMs).toLowerCase() : '';
      const timeB = row.b ? global.SubtitleParser.msToTime(row.b.startMs).toLowerCase() : '';
      return textA.includes(q) || textB.includes(q) || timeA.includes(q) || timeB.includes(q);
    });
  }

  const SORT_ACCESSORS = {
    timeA: row => (row.a ? row.a.startMs : Infinity),
    timeB: row => (row.b ? row.b.startMs : Infinity),
    diff: row => (row.diffMs === null ? Infinity : Math.abs(row.diffMs)),
    quality: row => QUALITY_ORDER[row.quality ? row.quality.key : 'none'],
    textA: row => (row.a ? row.a.text.toLowerCase() : ''),
    textB: row => (row.b ? row.b.text.toLowerCase() : '')
  };
  const QUALITY_ORDER = { excellent: 0, good: 1, poor: 2, bad: 3, none: 4 };

  function sortRows(rows, key, direction) {
    const accessor = SORT_ACCESSORS[key];
    if (!accessor) return rows;
    const dir = direction === 'desc' ? -1 : 1;
    return [...rows].sort((r1, r2) => {
      const v1 = accessor(r1), v2 = accessor(r2);
      if (v1 < v2) return -1 * dir;
      if (v1 > v2) return 1 * dir;
      return 0;
    });
  }

  /* ---------------------------------------------------------------------
   * DOM rendering
   * ------------------------------------------------------------------- */

  function renderStats(container, stats, filenameA, filenameB) {
    const cards = [
      ['Subtitle count A', stats.countA],
      ['Subtitle count B', stats.countB],
      ['Matched', stats.matchedCount],
      ['Unmatched', stats.unmatchedCount],
      ['Average offset', formatSecondsSigned(stats.averageOffsetMs)],
      ['Median offset', formatSecondsSigned(stats.medianOffsetMs)],
      ['Max difference', formatSeconds(stats.maxDiffMs)]
    ];
    container.innerHTML = cards.map(([label, value]) => `
      <div class="stat-card">
        <div class="stat-value">${value}</div>
        <div class="stat-label">${label}</div>
      </div>`).join('');
  }

  function renderSuggestions(container, suggestions) {
    if (!suggestions || suggestions.length === 0) {
      container.hidden = true;
      container.innerHTML = '';
      return;
    }
    container.hidden = false;
    container.innerHTML = suggestions.map(s => `<p>${escapeHtml(s)}</p>`).join('');
  }

  function formatSeconds(ms) {
    return (ms / 1000).toFixed(2) + 's';
  }
  function formatSecondsSigned(ms) {
    const sign = ms > 0 ? '+' : '';
    return sign + (ms / 1000).toFixed(2) + 's';
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Renders one "pick" button for a single cue (the A or B side of a
   * row). Point sync now picks A and B lines *independently* — they
   * don't need to be in the same row, or even both present in it — so
   * each side gets its own button rather than one whole-row checkbox.
   *   - no cue on this side: disabled placeholder.
   *   - cue already part of a committed sync point: disabled, shows
   *     that point's number instead of the side letter.
   *   - cue currently the pending pick for this side: highlighted,
   *     click again to deselect.
   *   - otherwise: idle, clickable.
   * `syncInfo` is `{ pendingA, pendingB, points }` — pendingA/pendingB
   * are cue references (or null), points is an array of
   * `{ aCue, bCue }` already-committed anchors.
   */
  function renderSyncPickButton(rowId, side, cue, syncInfo) {
    const label = side === 'a' ? 'A' : 'B';
    if (!cue) {
      return `<button type="button" class="sync-pick" disabled aria-hidden="true">${label}</button>`;
    }
    const points = (syncInfo && syncInfo.points) || [];
    const pointIndex = points.findIndex(p => p.aCue === cue || p.bCue === cue);
    if (pointIndex !== -1) {
      return `<button type="button" class="sync-pick sync-pick-committed" disabled title="Sync point ${pointIndex + 1}">${pointIndex + 1}</button>`;
    }
    const pending = syncInfo && (side === 'a' ? syncInfo.pendingA === cue : syncInfo.pendingB === cue);
    const cls = pending ? 'sync-pick sync-pick-pending' : 'sync-pick';
    const title = pending
      ? 'Selected for a sync point — click to deselect'
      : `Pick this Subtitle ${label} line for a sync point`;
    return `<button type="button" class="${cls}" data-row-id="${rowId}" data-side="${side}" title="${title}">${label}</button>`;
  }

  /**
   * Renders the table body. Accepts an optional search query purely for
   * <mark> highlighting purposes (filtering already happened upstream);
   * keeping highlight-only concerns here avoids re-deriving the filtered
   * set twice. `syncInfo` (see renderSyncPickButton) drives the Sync
   * column's pick-button states.
   */
  function renderTable(tbody, rows, searchQuery, syncInfo) {
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="table-empty">No rows match the current search/filter.</td></tr>`;
      return;
    }

    const q = (searchQuery || '').trim();
    const html = rows.map(row => {
      const timeA = row.a ? global.SubtitleParser.msToTime(row.a.startMs) : '—';
      const timeB = row.b ? global.SubtitleParser.msToTime(row.b.startMs) : '—';
      const diffLabel = row.diffMs === null ? '—' : (row.diffMs >= 0 ? '+' : '') + row.diffMs + ' ms';
      const qKey = row.quality ? row.quality.key : 'none';
      const qLabel = row.quality ? row.quality.label : 'No match';
      const htmlA = highlight(row.htmlA || '', q);
      const htmlB = highlight(row.htmlB || '', q);
      const cellA = row.a
        ? `<td class="editable-cell" contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true" data-row-id="${row.id}" data-side="a">${htmlA}</td>`
        : `<td><span class="table-empty-cell">—</span></td>`;
      const cellB = row.b
        ? `<td class="editable-cell" contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true" data-row-id="${row.id}" data-side="b">${htmlB}</td>`
        : `<td><span class="table-empty-cell">—</span></td>`;
      const syncCell = `<td class="sync-cell">${renderSyncPickButton(row.id, 'a', row.a, syncInfo)}${renderSyncPickButton(row.id, 'b', row.b, syncInfo)}</td>`;

      return `
        <tr data-diff="${row.diffMs === null ? '' : row.diffMs}">
          ${syncCell}
          <td class="mono">${highlightPlain(timeA, q)}</td>
          <td class="mono">${highlightPlain(timeB, q)}</td>
          <td class="mono">${diffLabel}</td>
          <td><span class="quality-dot q-${qKey}"></span>${qLabel}</td>
          ${cellA}
          ${cellB}
        </tr>`;
    }).join('');

    tbody.innerHTML = html;
  }

  // Wraps plain (already-safe) text with <mark> around a case-insensitive
  // query match, without re-escaping HTML that diff.js already produced.
  function highlight(html, query) {
    if (!query) return html;
    // html may already contain <del>/<ins> tags from diff.js; only mark
    // text that sits outside of tags to avoid corrupting markup.
    const q = escapeRegExp(query);
    const re = new RegExp(`(${q})(?![^<]*>)`, 'ig');
    return html.replace(re, '<mark class="search-hit">$1</mark>');
  }
  function highlightPlain(text, query) {
    if (!query) return escapeHtml(text);
    const safe = escapeHtml(text);
    const q = escapeRegExp(escapeHtml(query));
    const re = new RegExp(`(${q})`, 'ig');
    return safe.replace(re, '<mark class="search-hit">$1</mark>');
  }
  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Toggles the visual sort-direction indicator on table headers. */
  function updateSortIndicators(theadRow, activeKey, direction) {
    theadRow.querySelectorAll('th').forEach(th => {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.key === activeKey) {
        th.classList.add(direction === 'desc' ? 'sort-desc' : 'sort-asc');
      }
    });
  }

  function updateFilterChips(filterRow, activeFilter) {
    filterRow.querySelectorAll('.chip').forEach(chip => {
      const isActive = chip.dataset.filter === activeFilter;
      chip.setAttribute('aria-pressed', String(isActive));
    });
  }

  global.SubtitleUI = {
    filterRows,
    searchRows,
    sortRows,
    renderStats,
    renderSuggestions,
    renderTable,
    updateSortIndicators,
    updateFilterChips,
    formatSeconds,
    formatSecondsSigned
  };

})(typeof window !== 'undefined' ? window : globalThis);
