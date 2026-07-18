/* ==========================================================================
   app.js
   Responsibility: wire the DOM to everything else. This is the only
   module allowed to know about specific element IDs from index.html.
   Owns the app's mutable state (loaded files, current rows/stats,
   current filter/sort/search) and reacts to user interaction by calling
   into parser/alignment/dtw/diff/statistics/graphs/export/ui.
   ========================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------------
   * State
   * ------------------------------------------------------------------- */
  const state = {
    fileA: null,        // { cues, format, encoding, filename }
    fileB: null,
    rows: [],            // annotated aligned rows (full set, unfiltered)
    stats: null,
    graphPoints: [],
    mode: 'monotonic',
    maxVarianceMs: null, // null = no limit; hard cap passed to Alignment.align
    filter: 'all',
    threshold: 0,
    search: '',
    sortKey: null,
    sortDir: 'asc',
    syncPoints: [],       // committed point-sync anchors: { aCue, bCue } — direct cue references, independent of row pairing
    pendingSyncA: null,    // cue picked for the A side of the next sync point, awaiting a B pick
    pendingSyncB: null,    // cue picked for the B side of the next sync point, awaiting an A pick
    lastVisibleRows: [],   // the exact array last passed to SubtitleUI.renderTable — tbody's <tr> order matches this 1:1
    scrubberDomainMax: SubtitleScrubber.THIRTY_MIN_MS
  };

  /* ---------------------------------------------------------------------
   * Element references
   * ------------------------------------------------------------------- */
  const el = {
    dropzoneA: document.getElementById('dropzoneA'),
    dropzoneB: document.getElementById('dropzoneB'),
    fileA: document.getElementById('fileA'),
    fileB: document.getElementById('fileB'),
    browseA: document.getElementById('browseA'),
    browseB: document.getElementById('browseB'),
    fileInfoA: document.getElementById('fileInfoA'),
    fileInfoB: document.getElementById('fileInfoB'),
    alignMode: document.getElementById('alignMode'),
    maxVariance: document.getElementById('maxVariance'),
    compareBtn: document.getElementById('compareBtn'),
    resetBtn: document.getElementById('resetBtn'),
    statusLine: document.getElementById('statusLine'),

    findReplacePanel: document.getElementById('findReplacePanel'),
    frFind: document.getElementById('frFind'),
    frReplace: document.getElementById('frReplace'),
    frRegex: document.getElementById('frRegex'),
    frCaseSensitive: document.getElementById('frCaseSensitive'),
    frTarget: document.getElementById('frTarget'),
    frApply: document.getElementById('frApply'),
    frStatus: document.getElementById('frStatus'),

    statsPanel: document.getElementById('statsPanel'),
    statsGrid: document.getElementById('statsGrid'),
    suggestionBox: document.getElementById('suggestionBox'),

    graphsPanel: document.getElementById('graphsPanel'),
    histogramCanvas: document.getElementById('histogramCanvas'),
    driftCanvas: document.getElementById('driftCanvas'),

    syncPanel: document.getElementById('syncPanel'),
    copyTimecodesAtoB: document.getElementById('copyTimecodesAtoB'),
    copyTimecodesBtoA: document.getElementById('copyTimecodesBtoA'),
    syncPointStatus: document.getElementById('syncPointStatus'),
    commitSyncPoint: document.getElementById('commitSyncPoint'),
    syncPointList: document.getElementById('syncPointList'),
    clearSyncPoints: document.getElementById('clearSyncPoints'),
    applySyncBtoA: document.getElementById('applySyncBtoA'),
    applySyncAtoB: document.getElementById('applySyncAtoB'),

    tableControls: document.getElementById('tableControls'),
    searchBox: document.getElementById('searchBox'),
    thresholdInput: document.getElementById('thresholdInput'),
    filterRow: document.getElementById('filterRow'),

    tablePanel: document.getElementById('tablePanel'),
    tableScroll: document.getElementById('tableScroll'),
    tableBody: document.getElementById('tableBody'),
    tableFootnote: document.getElementById('tableFootnote'),
    tableHead: document.querySelector('#compareTable thead tr'),
    timeScrubber: document.getElementById('timeScrubber'),
    scrubberCanvas: document.getElementById('scrubberCanvas'),

    exportPanel: document.getElementById('exportPanel'),
    exportSrtA: document.getElementById('exportSrtA'),
    exportSrtB: document.getElementById('exportSrtB')
  };

  /* ---------------------------------------------------------------------
   * File loading (drag/drop + browse), shared by slot A and slot B
   * ------------------------------------------------------------------- */

  function setupDropzone(zoneEl, inputEl, browseBtn, infoEl, slot) {
    browseBtn.addEventListener('click', () => inputEl.click());

    inputEl.addEventListener('change', () => {
      if (inputEl.files && inputEl.files[0]) loadFile(inputEl.files[0], slot, zoneEl, infoEl);
    });

    ['dragenter', 'dragover'].forEach(evt =>
      zoneEl.addEventListener(evt, e => { e.preventDefault(); zoneEl.classList.add('dragover'); })
    );
    ['dragleave', 'drop'].forEach(evt =>
      zoneEl.addEventListener(evt, e => { e.preventDefault(); zoneEl.classList.remove('dragover'); })
    );
    zoneEl.addEventListener('drop', e => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) loadFile(file, slot, zoneEl, infoEl);
    });
  }

  function loadFile(file, slot, zoneEl, infoEl) {
    setStatus(`Reading "${file.name}"…`, false);
    SubtitleParser.parseFile(file)
      .then(parsed => {
        state[slot === 'A' ? 'fileA' : 'fileB'] = parsed;
        zoneEl.classList.add('has-file');
        infoEl.hidden = false;
        infoEl.textContent = `${parsed.filename} — ${parsed.cues.length} cues (${parsed.encoding})`;
        setStatus(`Loaded ${parsed.filename}.`, false);
        updateCompareEnabled();
        updateFindReplaceState();
      })
      .catch(err => {
        zoneEl.classList.remove('has-file');
        infoEl.hidden = true;
        setStatus(err.message, true);
      });
  }

  function updateCompareEnabled() {
    el.compareBtn.disabled = !(state.fileA && state.fileB);
  }

  function setStatus(message, isError) {
    el.statusLine.textContent = message;
    el.statusLine.classList.toggle('error', !!isError);
  }

  /* ---------------------------------------------------------------------
   * Find & replace — bulk text edit across every cue of one loaded file,
   * with optional regex support. Independent of alignment (only text
   * changes, never timing), so it works before a compare has ever run;
   * if a compare HAS already run, affected rows are re-annotated so the
   * diff/table view picks up the new text without a full re-align.
   * ------------------------------------------------------------------- */

  function updateFindReplaceState() {
    const anyLoaded = !!(state.fileA || state.fileB);
    el.findReplacePanel.hidden = !anyLoaded;
    if (!anyLoaded) return;
    const targetFile = el.frTarget.value === 'A' ? state.fileA : state.fileB;
    el.frApply.disabled = !targetFile || el.frFind.value === '';
  }

  function setFindReplaceStatus(message, isError) {
    el.frStatus.textContent = message;
    el.frStatus.classList.toggle('error', !!isError);
  }

  function applyFindReplace() {
    const targetSlot = el.frTarget.value;
    const targetFile = targetSlot === 'A' ? state.fileA : state.fileB;
    if (!targetFile) {
      setFindReplaceStatus(`Load Subtitle ${targetSlot} first.`, true);
      return;
    }
    const find = el.frFind.value;
    if (!find) {
      setFindReplaceStatus('Enter text or a pattern to find.', true);
      return;
    }

    let pattern;
    try {
      pattern = SubtitleFindReplace.buildPattern(find, {
        useRegex: el.frRegex.checked,
        caseSensitive: el.frCaseSensitive.checked
      });
    } catch (err) {
      setFindReplaceStatus(`Invalid regex: ${err.message}`, true);
      return;
    }

    const { matchCount, cueCount } = SubtitleFindReplace.countMatches(targetFile.cues, pattern);
    if (matchCount === 0) {
      setFindReplaceStatus('No matches found.', false);
      return;
    }

    const confirmed = window.confirm(
      `Replace ${matchCount} match${matchCount === 1 ? '' : 'es'} across ${cueCount} line${cueCount === 1 ? '' : 's'} in Subtitle ${targetSlot}?`
    );
    if (!confirmed) return;

    const replacement = el.frReplace.value;
    SubtitleFindReplace.replaceInCues(targetFile.cues, pattern, replacement);
    setFindReplaceStatus(`Replaced ${matchCount} match${matchCount === 1 ? '' : 'es'} across ${cueCount} line${cueCount === 1 ? '' : 's'} in Subtitle ${targetSlot}.`, false);

    // Timing is untouched — just re-annotate so the diff/table view
    // reflects the new text, no need to re-run alignment.
    if (state.rows.length) {
      state.rows.forEach(row => SubtitleStats.annotateRow(row));
      renderTableWithCurrentFilters();
    }
  }

  function setupFindReplace() {
    el.frFind.addEventListener('input', updateFindReplaceState);
    el.frTarget.addEventListener('change', updateFindReplaceState);
    el.frApply.addEventListener('click', applyFindReplace);
    [el.frFind, el.frReplace].forEach(input => {
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !el.frApply.disabled) applyFindReplace();
      });
    });
  }

  /* ---------------------------------------------------------------------
   * Compare
   * ------------------------------------------------------------------- */

  function runCompare() {
    if (!state.fileA || !state.fileB) return;
    setStatus('Aligning subtitles…', false);
    el.compareBtn.disabled = true;

    // Defer to the next frame so the "Aligning…" status actually paints
    // before a potentially heavy synchronous DP/DTW run blocks the
    // main thread.
    requestAnimationFrame(() => {
      setTimeout(() => {
        try {
          performCompare();
        } catch (err) {
          console.error(err);
          setStatus(`Comparison failed: ${err.message}`, true);
        } finally {
          el.compareBtn.disabled = false;
        }
      }, 10);
    });
  }

  // Shared by the Compare button and by anything that mutates cue
  // timing after a compare has already run (copy timecodes, point
  // sync) — those need a full re-align since every row's diff/quality
  // may now be different, not just the rows that were touched.
  function performCompare() {
    const t0 = performance.now();
    const rawRows = Alignment.align(state.mode, state.fileA.cues, state.fileB.cues, { maxVarianceMs: state.maxVarianceMs });
    SubtitleStats.annotateRows(rawRows);
    state.rows = rawRows;
    state.stats = SubtitleStats.computeStatistics(rawRows, state.fileA.cues.length, state.fileB.cues.length);
    state.graphPoints = SubtitleStats.computeGraphData(rawRows);
    // Sync points reference cue objects directly (not row ids), so they
    // stay valid across re-alignment — row ids get reassigned every
    // align, but the underlying cues (and the user's chosen anchors)
    // are untouched by which row they end up paired into.
    const elapsed = (performance.now() - t0).toFixed(0);

    renderAll();
    setStatus(`Compared ${state.fileA.cues.length} vs ${state.fileB.cues.length} cues in ${elapsed} ms using ${state.mode} mode.`, false);
  }

  function renderAll() {
    [el.statsPanel, el.graphsPanel, el.syncPanel, el.tableControls, el.tablePanel, el.exportPanel].forEach(p => p.hidden = false);

    SubtitleUI.renderStats(el.statsGrid, state.stats);
    const suggestions = SubtitleStats.detectPatterns(state.rows, state.stats);
    SubtitleUI.renderSuggestions(el.suggestionBox, suggestions);

    SubtitleGraphs.drawHistogram(el.histogramCanvas, state.graphPoints);
    SubtitleGraphs.drawDriftGraph(el.driftCanvas, state.graphPoints);

    renderTableWithCurrentFilters();
  }

  function renderTableWithCurrentFilters() {
    let visible = SubtitleUI.filterRows(state.rows, state.filter, state.threshold);
    visible = SubtitleUI.searchRows(visible, state.search);
    if (state.sortKey) visible = SubtitleUI.sortRows(visible, state.sortKey, state.sortDir);
    state.lastVisibleRows = visible;
    const syncInfo = { pendingA: state.pendingSyncA, pendingB: state.pendingSyncB, points: state.syncPoints };
    SubtitleUI.renderTable(el.tableBody, visible, state.search, syncInfo);
    el.tableFootnote.textContent = `Showing ${visible.length} of ${state.rows.length} rows.`;
    updateScrubber();
  }

  /* ---------------------------------------------------------------------
   * Time scrubber — a clickable/draggable axis next to the table for
   * jumping straight to a timestamp in a long file. The axis domain is
   * derived from ALL rows (state.rows) so it stays stable as filters
   * change; clicking/dragging maps to the currently-rendered row set
   * (state.lastVisibleRows), since that's what's actually in the DOM to
   * scroll to.
   * ------------------------------------------------------------------- */

  function updateScrubber() {
    state.scrubberDomainMax = SubtitleScrubber.computeDomain(state.rows);
    SubtitleScrubber.draw(el.scrubberCanvas, state.scrubberDomainMax, computeViewportRange());
  }

  function computeViewportRange() {
    if (state.lastVisibleRows.length === 0) return null;
    const trs = el.tableBody.querySelectorAll('tr[data-diff]');
    if (trs.length === 0) return null;
    const scrollTop = el.tableScroll.scrollTop;
    const viewBottom = scrollTop + el.tableScroll.clientHeight;

    let startIdx = null, endIdx = null;
    trs.forEach((tr, idx) => {
      const top = tr.offsetTop;
      const bottom = top + tr.offsetHeight;
      if (bottom >= scrollTop && top <= viewBottom) {
        if (startIdx === null) startIdx = idx;
        endIdx = idx;
      }
    });
    if (startIdx === null) return null;

    const startMs = SubtitleScrubber.rowTime(state.lastVisibleRows[startIdx]);
    const endMs = SubtitleScrubber.rowTime(state.lastVisibleRows[endIdx]);
    if (startMs === null && endMs === null) return null;
    return { startMs: startMs ?? endMs, endMs: endMs ?? startMs };
  }

  function jumpToScrubberY(clientY) {
    if (state.lastVisibleRows.length === 0) return;
    const rect = el.scrubberCanvas.getBoundingClientRect();
    const targetMs = SubtitleScrubber.timeAtY(clientY - rect.top, rect.height, state.scrubberDomainMax);
    const idx = SubtitleScrubber.nearestRowIndex(state.lastVisibleRows, targetMs);
    if (idx === -1) return;
    const tr = el.tableBody.children[idx];
    if (!tr) return;
    el.tableScroll.scrollTop = tr.offsetTop;
  }

  function setupScrubber() {
    let dragging = false;
    el.timeScrubber.addEventListener('mousedown', e => {
      dragging = true;
      jumpToScrubberY(e.clientY);
    });
    window.addEventListener('mousemove', e => {
      if (dragging) jumpToScrubberY(e.clientY);
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    let scrollPending = false;
    el.tableScroll.addEventListener('scroll', () => {
      if (scrollPending) return;
      scrollPending = true;
      requestAnimationFrame(() => {
        scrollPending = false;
        SubtitleScrubber.draw(el.scrubberCanvas, state.scrubberDomainMax, computeViewportRange());
      });
    });
  }

  /* ---------------------------------------------------------------------
   * Table controls: search, threshold, filter chips, column sort
   * ------------------------------------------------------------------- */

  function setupTableControls() {
    let debounceHandle = null;
    el.searchBox.addEventListener('input', () => {
      clearTimeout(debounceHandle);
      debounceHandle = setTimeout(() => {
        state.search = el.searchBox.value;
        renderTableWithCurrentFilters();
      }, 120);
    });

    el.thresholdInput.addEventListener('input', () => {
      const v = parseInt(el.thresholdInput.value, 10);
      state.threshold = isNaN(v) ? 0 : v;
      renderTableWithCurrentFilters();
    });

    el.filterRow.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      state.filter = chip.dataset.filter;
      SubtitleUI.updateFilterChips(el.filterRow, state.filter);
      renderTableWithCurrentFilters();
    });

    el.tableHead.addEventListener('click', e => {
      const th = e.target.closest('th');
      if (!th || !th.dataset.key) return;
      if (state.sortKey === th.dataset.key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = th.dataset.key;
        state.sortDir = 'asc';
      }
      SubtitleUI.updateSortIndicators(el.tableHead, state.sortKey, state.sortDir);
      renderTableWithCurrentFilters();
    });
  }

  /* ---------------------------------------------------------------------
   * Timecode tools — copy timecodes wholesale from one file to the
   * other, or "point sync".
   *
   * Point sync picks A and B lines *independently*: click "A" on
   * whichever row has the right Subtitle A line, click "B" on
   * whichever (possibly completely different) row has the right
   * Subtitle B line, then "Set sync point" commits that pair as one
   * anchor. This is deliberately decoupled from the aligned table's own
   * row pairing, since that pairing is exactly what point sync exists
   * to correct — trusting it to pick anchors would be circular for
   * files that are badly out of sync. Repeat for a second (or more)
   * point, then apply.
   *
   * Both copy-timecodes and point-sync mutate cue objects in place
   * (same instances the table/rows reference, per the pattern inline
   * text editing already uses) and then re-run the full compare, since
   * every cue on the target side may have moved — not just the rows
   * that were selected.
   * ------------------------------------------------------------------- */

  function copyTimecodes(direction) {
    const eligible = state.rows.filter(r => r.a && r.b).length;
    if (eligible === 0) {
      setStatus('No matched rows to copy timecodes for.', true);
      return;
    }
    const label = direction === 'aToB' ? 'A → B' : 'B → A';
    const confirmed = window.confirm(
      `Copy timecodes ${label} for ${eligible} matched line${eligible === 1 ? '' : 's'}? ` +
      `This overwrites the destination file's timing.`
    );
    if (!confirmed) return;

    SubtitleSync.copyTimecodes(state.rows, direction);
    setStatus(`Copied timecodes ${label} for ${eligible} line${eligible === 1 ? '' : 's'}. Re-aligning…`, false);
    runCompare();
  }

  function applyPointSync(direction) {
    if (state.syncPoints.length < 2) {
      setStatus('Set at least 2 sync points first.', true);
      return;
    }

    const syncingB = direction === 'bToA';
    const anchors = state.syncPoints.map(p => syncingB
      ? { from: p.bCue.startMs, to: p.aCue.startMs }
      : { from: p.aCue.startMs, to: p.bCue.startMs });
    const targetCues = syncingB ? state.fileB.cues : state.fileA.cues;
    const targetLabel = syncingB ? 'B' : 'A';
    const refLabel = syncingB ? 'A' : 'B';
    const n = state.syncPoints.length;

    const confirmed = window.confirm(
      `Shift & stretch Subtitle ${targetLabel}'s timecodes to align with Subtitle ${refLabel} around ${n} sync points? ` +
      `This overwrites Subtitle ${targetLabel}'s timing.`
    );
    if (!confirmed) return;

    try {
      SubtitleSync.applyPointSync(targetCues, anchors);
    } catch (err) {
      setStatus(err.message, true);
      return;
    }
    setStatus(`Synced Subtitle ${targetLabel} to Subtitle ${refLabel} using ${n} points. Re-aligning…`, false);
    runCompare();
  }

  function pickSyncCue(rowId, side) {
    const row = state.rows.find(r => r.id === rowId);
    if (!row) return;
    const cue = side === 'a' ? row.a : row.b;
    if (!cue) return;
    // A cue already locked into a committed sync point isn't pickable —
    // remove it from the list first if it needs to change.
    if (state.syncPoints.some(p => p.aCue === cue || p.bCue === cue)) return;

    if (side === 'a') {
      state.pendingSyncA = (state.pendingSyncA === cue) ? null : cue; // click again to deselect
    } else {
      state.pendingSyncB = (state.pendingSyncB === cue) ? null : cue;
    }
    updateSyncPointUI();
    renderTableWithCurrentFilters();
  }

  function commitSyncPoint() {
    if (!state.pendingSyncA || !state.pendingSyncB) return;
    state.syncPoints.push({ aCue: state.pendingSyncA, bCue: state.pendingSyncB });
    state.pendingSyncA = null;
    state.pendingSyncB = null;
    updateSyncPointUI();
    renderTableWithCurrentFilters();
  }

  function removeSyncPoint(index) {
    state.syncPoints.splice(index, 1);
    updateSyncPointUI();
    renderTableWithCurrentFilters();
  }

  function clearSyncPoints() {
    state.syncPoints = [];
    state.pendingSyncA = null;
    state.pendingSyncB = null;
    updateSyncPointUI();
    renderTableWithCurrentFilters();
  }

  function setupSyncPointSelection() {
    el.tableBody.addEventListener('click', e => {
      const btn = e.target.closest('.sync-pick');
      if (!btn || btn.disabled) return;
      pickSyncCue(Number(btn.dataset.rowId), btn.dataset.side);
    });

    el.commitSyncPoint.addEventListener('click', commitSyncPoint);
    el.clearSyncPoints.addEventListener('click', clearSyncPoints);

    el.syncPointList.addEventListener('click', e => {
      const btn = e.target.closest('.sync-point-remove');
      if (!btn) return;
      removeSyncPoint(Number(btn.dataset.index));
    });

    el.applySyncBtoA.addEventListener('click', () => applyPointSync('bToA'));
    el.applySyncAtoB.addEventListener('click', () => applyPointSync('aToB'));
  }

  function updateSyncPointUI() {
    // Status line guides the user through the pick-A / pick-B / commit sequence.
    if (state.pendingSyncA && state.pendingSyncB) {
      el.syncPointStatus.textContent = 'Both lines picked — click "Set sync point" to save this pair.';
    } else if (state.pendingSyncA) {
      el.syncPointStatus.textContent = `A picked at ${SubtitleParser.msToTime(state.pendingSyncA.startMs)} — now pick the matching Subtitle B line.`;
    } else if (state.pendingSyncB) {
      el.syncPointStatus.textContent = `B picked at ${SubtitleParser.msToTime(state.pendingSyncB.startMs)} — now pick the matching Subtitle A line.`;
    } else {
      el.syncPointStatus.textContent = state.syncPoints.length === 0
        ? 'Pick a line in Subtitle A, then its match in Subtitle B.'
        : 'Pick another A/B pair, or apply the sync points below.';
    }
    el.commitSyncPoint.disabled = !(state.pendingSyncA && state.pendingSyncB);

    el.syncPointList.innerHTML = state.syncPoints.map((p, i) => `
      <li class="sync-point-item">
        <span class="sync-point-badge">${i + 1}</span>
        <span class="sync-point-times">A ${SubtitleParser.msToTime(p.aCue.startMs)} &harr; B ${SubtitleParser.msToTime(p.bCue.startMs)}</span>
        <button type="button" class="sync-point-remove" data-index="${i}" aria-label="Remove sync point ${i + 1}">&times;</button>
      </li>`).join('');

    const ready = state.syncPoints.length >= 2;
    el.applySyncBtoA.disabled = !ready;
    el.applySyncAtoB.disabled = !ready;
  }

  /* ---------------------------------------------------------------------
   * Inline editing — subtitle text cells are contenteditable. Editing is
   * wired here (not ui.js) via delegation on the table body so it keeps
   * working across re-renders without needing to be reattached per row.
   *
   * row.a / row.b are the SAME object instances as the entries in
   * state.fileA.cues / state.fileB.cues (alignment.js pushes direct cue
   * references into each row), so editing a cell here also mutates the
   * underlying cue — which is exactly what lets "export as .srt" pick up
   * edits with no extra bookkeeping.
   * ------------------------------------------------------------------- */

  function findRowById(id) {
    const numId = Number(id);
    return state.rows.find(row => row.id === numId);
  }

  function setupInlineEditing() {
    el.tableBody.addEventListener('focusin', e => {
      const cell = e.target.closest('.editable-cell');
      if (!cell) return;
      const row = findRowById(cell.dataset.rowId);
      if (!row) return;
      const cue = cell.dataset.side === 'a' ? row.a : row.b;
      // Swap to plain text while editing — editing directly over the
      // diff-highlighted <del>/<ins> markup would let keystrokes land
      // inside those tags and corrupt the rendered diff.
      cell.textContent = cue.text;
    });

    el.tableBody.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const cell = e.target.closest('.editable-cell');
      if (!cell) return;
      e.preventDefault();
      cell.dataset.cancelled = 'true';
      cell.blur();
    });

    // Force plain-text paste so edits can't drag in foreign HTML
    // formatting (or markup that would masquerade as diff spans) from
    // whatever the user copied the replacement text from.
    el.tableBody.addEventListener('paste', e => {
      const cell = e.target.closest('.editable-cell');
      if (!cell) return;
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    });

    el.tableBody.addEventListener('focusout', e => {
      const cell = e.target.closest('.editable-cell');
      if (!cell) return;
      const cancelled = cell.dataset.cancelled === 'true';
      delete cell.dataset.cancelled;

      if (!cancelled) {
        const row = findRowById(cell.dataset.rowId);
        if (row) {
          const cue = cell.dataset.side === 'a' ? row.a : row.b;
          const newText = cell.innerText.replace(/\n+$/, '');
          if (newText !== cue.text) {
            cue.text = newText;
            cue.lines = newText.split('\n');
            SubtitleStats.annotateRow(row);
          }
        }
      }
      // Always re-render: restores the diff-highlighted view we swapped
      // out on focus, whether or not anything actually changed.
      renderTableWithCurrentFilters();
    });
  }

  /* ---------------------------------------------------------------------
   * Reset
   * ------------------------------------------------------------------- */

  function resetAll() {
    state.fileA = null;
    state.fileB = null;
    state.rows = [];
    state.stats = null;
    state.graphPoints = [];
    state.filter = 'all';
    state.threshold = 0;
    state.search = '';
    state.sortKey = null;
    state.sortDir = 'asc';
    state.syncPoints = [];
    state.pendingSyncA = null;
    state.pendingSyncB = null;
    state.lastVisibleRows = [];
    state.scrubberDomainMax = SubtitleScrubber.THIRTY_MIN_MS;

    [el.dropzoneA, el.dropzoneB].forEach(z => z.classList.remove('has-file', 'dragover'));
    [el.fileInfoA, el.fileInfoB].forEach(i => { i.hidden = true; i.textContent = ''; });
    el.fileA.value = '';
    el.fileB.value = '';
    el.searchBox.value = '';
    el.thresholdInput.value = '';
    SubtitleUI.updateFilterChips(el.filterRow, 'all');
    updateSyncPointUI();

    el.frFind.value = '';
    el.frReplace.value = '';
    el.frRegex.checked = false;
    el.frCaseSensitive.checked = false;
    el.frTarget.value = 'A';
    setFindReplaceStatus('', false);

    [el.statsPanel, el.graphsPanel, el.syncPanel, el.tableControls, el.tablePanel, el.exportPanel].forEach(p => p.hidden = true);
    el.tableBody.innerHTML = '';
    setStatus('', false);
    updateCompareEnabled();
    updateFindReplaceState();
  }

  /* ---------------------------------------------------------------------
   * Init
   * ------------------------------------------------------------------- */

  function init() {
    setupDropzone(el.dropzoneA, el.fileA, el.browseA, el.fileInfoA, 'A');
    setupDropzone(el.dropzoneB, el.fileB, el.browseB, el.fileInfoB, 'B');

    el.alignMode.addEventListener('change', () => { state.mode = el.alignMode.value; });
    el.maxVariance.addEventListener('input', () => {
      const v = parseFloat(el.maxVariance.value);
      state.maxVarianceMs = (!isNaN(v) && v >= 0) ? Math.round(v * 1000) : null;
    });
    el.compareBtn.addEventListener('click', runCompare);
    el.resetBtn.addEventListener('click', resetAll);

    setupTableControls();
    setupInlineEditing();
    setupSyncPointSelection();
    setupFindReplace();
    setupScrubber();

    el.copyTimecodesAtoB.addEventListener('click', () => copyTimecodes('aToB'));
    el.copyTimecodesBtoA.addEventListener('click', () => copyTimecodes('bToA'));

    el.exportSrtA.addEventListener('click', () =>
      SubtitleExport.downloadSrt(state.fileA.cues, srtFilenameFor(state.fileA.filename))
    );
    el.exportSrtB.addEventListener('click', () =>
      SubtitleExport.downloadSrt(state.fileB.cues, srtFilenameFor(state.fileB.filename))
    );

    updateCompareEnabled();
    updateFindReplaceState();
  }

  function srtFilenameFor(originalName) {
    return originalName.replace(/\.[^./\\]+$/, '') + '.edited.srt';
  }

  document.addEventListener('DOMContentLoaded', init);

})();
