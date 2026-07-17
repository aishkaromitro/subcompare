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
    filter: 'all',
    threshold: 0,
    search: '',
    sortKey: null,
    sortDir: 'asc'
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
    compareBtn: document.getElementById('compareBtn'),
    resetBtn: document.getElementById('resetBtn'),
    statusLine: document.getElementById('statusLine'),

    statsPanel: document.getElementById('statsPanel'),
    statsGrid: document.getElementById('statsGrid'),
    suggestionBox: document.getElementById('suggestionBox'),

    graphsPanel: document.getElementById('graphsPanel'),
    histogramCanvas: document.getElementById('histogramCanvas'),
    driftCanvas: document.getElementById('driftCanvas'),

    tableControls: document.getElementById('tableControls'),
    searchBox: document.getElementById('searchBox'),
    thresholdInput: document.getElementById('thresholdInput'),
    filterRow: document.getElementById('filterRow'),

    tablePanel: document.getElementById('tablePanel'),
    tableBody: document.getElementById('tableBody'),
    tableFootnote: document.getElementById('tableFootnote'),
    tableHead: document.querySelector('#compareTable thead tr'),

    exportPanel: document.getElementById('exportPanel'),
    exportCsv: document.getElementById('exportCsv'),
    exportJson: document.getElementById('exportJson'),
    exportHtml: document.getElementById('exportHtml'),
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
          const t0 = performance.now();
          const rawRows = Alignment.align(state.mode, state.fileA.cues, state.fileB.cues);
          SubtitleStats.annotateRows(rawRows);
          state.rows = rawRows;
          state.stats = SubtitleStats.computeStatistics(rawRows, state.fileA.cues.length, state.fileB.cues.length);
          state.graphPoints = SubtitleStats.computeGraphData(rawRows);
          const elapsed = (performance.now() - t0).toFixed(0);

          renderAll();
          setStatus(`Compared ${state.fileA.cues.length} vs ${state.fileB.cues.length} cues in ${elapsed} ms using ${state.mode} mode.`, false);
        } catch (err) {
          console.error(err);
          setStatus(`Comparison failed: ${err.message}`, true);
        } finally {
          el.compareBtn.disabled = false;
        }
      }, 10);
    });
  }

  function renderAll() {
    [el.statsPanel, el.graphsPanel, el.tableControls, el.tablePanel, el.exportPanel].forEach(p => p.hidden = false);

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
    SubtitleUI.renderTable(el.tableBody, visible, state.search);
    el.tableFootnote.textContent = `Showing ${visible.length} of ${state.rows.length} rows.`;
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

    [el.dropzoneA, el.dropzoneB].forEach(z => z.classList.remove('has-file', 'dragover'));
    [el.fileInfoA, el.fileInfoB].forEach(i => { i.hidden = true; i.textContent = ''; });
    el.fileA.value = '';
    el.fileB.value = '';
    el.searchBox.value = '';
    el.thresholdInput.value = '';
    SubtitleUI.updateFilterChips(el.filterRow, 'all');

    [el.statsPanel, el.graphsPanel, el.tableControls, el.tablePanel, el.exportPanel].forEach(p => p.hidden = true);
    el.tableBody.innerHTML = '';
    setStatus('', false);
    updateCompareEnabled();
  }

  /* ---------------------------------------------------------------------
   * Init
   * ------------------------------------------------------------------- */

  function init() {
    setupDropzone(el.dropzoneA, el.fileA, el.browseA, el.fileInfoA, 'A');
    setupDropzone(el.dropzoneB, el.fileB, el.browseB, el.fileInfoB, 'B');

    el.alignMode.addEventListener('change', () => { state.mode = el.alignMode.value; });
    el.compareBtn.addEventListener('click', runCompare);
    el.resetBtn.addEventListener('click', resetAll);

    setupTableControls();
    setupInlineEditing();

    el.exportCsv.addEventListener('click', () => SubtitleExport.downloadCsv(state.rows));
    el.exportJson.addEventListener('click', () =>
      SubtitleExport.downloadJson(state.rows, state.stats, { filenameA: state.fileA.filename, filenameB: state.fileB.filename, mode: state.mode })
    );
    el.exportHtml.addEventListener('click', () =>
      SubtitleExport.downloadHtmlReport(state.rows, state.stats, { filenameA: state.fileA.filename, filenameB: state.fileB.filename, mode: state.mode })
    );
    el.exportSrtA.addEventListener('click', () =>
      SubtitleExport.downloadSrt(state.fileA.cues, srtFilenameFor(state.fileA.filename))
    );
    el.exportSrtB.addEventListener('click', () =>
      SubtitleExport.downloadSrt(state.fileB.cues, srtFilenameFor(state.fileB.filename))
    );

    updateCompareEnabled();
  }

  function srtFilenameFor(originalName) {
    return originalName.replace(/\.[^./\\]+$/, '') + '.edited.srt';
  }

  document.addEventListener('DOMContentLoaded', init);

})();
