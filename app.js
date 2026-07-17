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

    tcReadout: document.getElementById('tcReadout')
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
   * Live timecode readout in the header — a small ambient touch, not
   * tied to app state; just ticks with the wall clock.
   * ------------------------------------------------------------------- */
  function startHeaderClock() {
    if (!el.tcReadout) return;
    const start = performance.now();
    function tick() {
      const elapsed = performance.now() - start;
      el.tcReadout.textContent = SubtitleParser.msToTime(elapsed % 3600000);
      requestAnimationFrame(tick);
    }
    tick();
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

    el.exportCsv.addEventListener('click', () => SubtitleExport.downloadCsv(state.rows));
    el.exportJson.addEventListener('click', () =>
      SubtitleExport.downloadJson(state.rows, state.stats, { filenameA: state.fileA.filename, filenameB: state.fileB.filename, mode: state.mode })
    );
    el.exportHtml.addEventListener('click', () =>
      SubtitleExport.downloadHtmlReport(state.rows, state.stats, { filenameA: state.fileA.filename, filenameB: state.fileB.filename, mode: state.mode })
    );

    startHeaderClock();
    updateCompareEnabled();
  }

  document.addEventListener('DOMContentLoaded', init);

})();
