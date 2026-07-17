/* ==========================================================================
   export.js
   Responsibility: turn the current comparison (rows + stats) into
   downloadable CSV, JSON, or a fully standalone HTML report.

   Split deliberately into pure "build*" functions (return a string,
   fully unit-testable without a browser) and a thin "download*" wrapper
   per format that does the actual Blob/anchor-click dance. ui.js/app.js
   only ever call the download* functions.
   ========================================================================== */

(function (global) {
  'use strict';

  const P = () => global.SubtitleParser; // lazy lookup, avoids load-order coupling

  function csvEscape(value) {
    const s = String(value ?? '');
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /** Builds a CSV string from the (annotated) comparison rows. */
  function buildCsv(rows) {
    const header = ['Time A', 'Time B', 'Time Diff (ms)', 'Match Quality', 'Subtitle A', 'Subtitle B'];
    const lines = [header.map(csvEscape).join(',')];
    for (const row of rows) {
      const timeA = row.a ? P().msToTime(row.a.startMs) : '';
      const timeB = row.b ? P().msToTime(row.b.startMs) : '';
      const diff = row.diffMs === null ? '' : row.diffMs;
      const quality = row.quality ? row.quality.label : '';
      const textA = row.a ? row.a.text.replace(/\n/g, ' / ') : '';
      const textB = row.b ? row.b.text.replace(/\n/g, ' / ') : '';
      lines.push([timeA, timeB, diff, quality, textA, textB].map(csvEscape).join(','));
    }
    return lines.join('\r\n');
  }

  /** Builds a JSON string bundling stats + full row detail. */
  function buildJson(rows, stats, meta) {
    const payload = {
      meta: meta || {},
      statistics: stats,
      rows: rows.map(row => ({
        timeA: row.a ? P().msToTime(row.a.startMs) : null,
        timeB: row.b ? P().msToTime(row.b.startMs) : null,
        diffMs: row.diffMs,
        quality: row.quality ? row.quality.key : 'none',
        textA: row.a ? row.a.text : null,
        textB: row.b ? row.b.text : null
      }))
    };
    return JSON.stringify(payload, null, 2);
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Serializes a cue array (e.g. state.fileA.cues, possibly carrying
   * inline edits made in the table) back into standard SRT text.
   * Cue indices are renumbered sequentially — the original numbering
   * from the source file isn't meaningful after edits and may have
   * gaps, so a clean 1..N sequence is the only thing worth writing out.
   */
  function buildSrt(cues) {
    const sorted = [...cues].sort((a, b) => a.startMs - b.startMs);
    const blocks = sorted.map((cue, i) => {
      const start = P().msToTime(cue.startMs);
      const end = P().msToTime(cue.endMs);
      return `${i + 1}\n${start} --> ${end}\n${cue.text}`;
    });
    return blocks.join('\n\n') + '\n';
  }

  /**
   * Builds a fully self-contained HTML report: stats table, comparison
   * table with the same colour coding as the live app, embedded CSS,
   * no external requests of any kind. This is a snapshot, not the live
   * app — it renders diff HTML that was already computed, rather than
   * re-loading all of diff.js/statistics.js into the report.
   */
  function buildHtmlReport(rows, stats, meta) {
    const generatedAt = new Date().toISOString();
    const statCards = [
      ['Subtitle count A', stats.countA],
      ['Subtitle count B', stats.countB],
      ['Matched', stats.matchedCount],
      ['Unmatched', stats.unmatchedCount],
      ['Average offset', (stats.averageOffsetMs / 1000).toFixed(3) + 's'],
      ['Median offset', (stats.medianOffsetMs / 1000).toFixed(3) + 's'],
      ['Max difference', (stats.maxDiffMs / 1000).toFixed(3) + 's']
    ].map(([label, value]) => `
        <div class="stat"><div class="stat-value">${escapeHtml(value)}</div><div class="stat-label">${escapeHtml(label)}</div></div>`).join('');

    const rowsHtml = rows.map(row => {
      const timeA = row.a ? P().msToTime(row.a.startMs) : '—';
      const timeB = row.b ? P().msToTime(row.b.startMs) : '—';
      const diff = row.diffMs === null ? '—' : (row.diffMs >= 0 ? '+' : '') + row.diffMs + ' ms';
      const qKey = row.quality ? row.quality.key : 'none';
      const qLabel = row.quality ? row.quality.label : 'No match';
      const htmlA = row.htmlA || (row.a ? escapeHtml(row.a.text) : '');
      const htmlB = row.htmlB || (row.b ? escapeHtml(row.b.text) : '');
      return `
        <tr class="q-${qKey}">
          <td class="mono">${escapeHtml(timeA)}</td>
          <td class="mono">${escapeHtml(timeB)}</td>
          <td class="mono">${escapeHtml(diff)}</td>
          <td><span class="dot dot-${qKey}"></span>${escapeHtml(qLabel)}</td>
          <td>${htmlA.replace(/\n/g, '<br>')}</td>
          <td>${htmlB.replace(/\n/g, '<br>')}</td>
        </tr>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Subtitle Comparison Report</title>
<style>
  :root {
    --bg:#0B0D10; --panel:#14171C; --border:#262B33; --text:#E7EAEE; --text-muted:#8892A0;
    --accent:#F2B84B; --excellent:#6FCF97; --good:#F2C94C; --poor:#F2994A; --bad:#EB5757; --none:#4A5568;
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,Segoe UI,Roboto,sans-serif; font-size:14px; }
  header { padding:24px; border-bottom:1px solid var(--border); }
  h1 { margin:0 0 4px; font-size:18px; }
  .meta { color:var(--text-muted); font-size:12.5px; }
  main { padding:24px; max-width:1180px; margin:0 auto; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-bottom:24px; }
  .stat { background:var(--panel); border:1px solid var(--border); border-radius:6px; padding:12px 14px; }
  .stat-value { font-family:ui-monospace,monospace; font-size:19px; color:var(--accent); }
  .stat-label { font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.05em; margin-top:4px; }
  table { width:100%; border-collapse:collapse; font-size:13px; background:var(--panel); border:1px solid var(--border); }
  th, td { padding:8px 12px; border-bottom:1px solid var(--border); text-align:left; vertical-align:top; }
  th { background:#1A1E25; color:var(--text-muted); font-size:11px; text-transform:uppercase; letter-spacing:.05em; position:sticky; top:0; }
  .mono { font-family:ui-monospace,monospace; font-size:12.5px; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:6px; }
  .dot-excellent{background:var(--excellent)} .dot-good{background:var(--good)} .dot-poor{background:var(--poor)} .dot-bad{background:var(--bad)} .dot-none{background:var(--none)}
  del { background:rgba(235,87,87,.18); color:var(--bad); text-decoration:line-through; border-radius:3px; }
  ins { background:rgba(111,207,151,.18); color:var(--excellent); text-decoration:none; border-radius:3px; }
  tr.q-bad td:nth-child(3), tr.q-poor td:nth-child(3) { color: var(--poor); }
</style>
</head>
<body>
  <header>
    <h1>Subtitle Comparison Report</h1>
    <div class="meta">${escapeHtml(meta && meta.filenameA || 'Subtitle A')} vs ${escapeHtml(meta && meta.filenameB || 'Subtitle B')} · mode: ${escapeHtml(meta && meta.mode || 'n/a')} · generated ${generatedAt}</div>
  </header>
  <main>
    <div class="stats">${statCards}</div>
    <table>
      <thead><tr><th>Time A</th><th>Time B</th><th>Diff</th><th>Match</th><th>Subtitle A</th><th>Subtitle B</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </main>
</body>
</html>`;
  }

  /* ---------------------------------------------------------------------
   * Browser-side download triggers (thin wrappers around the builders)
   * ------------------------------------------------------------------- */

  function triggerDownload(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadCsv(rows) {
    triggerDownload(buildCsv(rows), 'subtitle-comparison.csv', 'text/csv;charset=utf-8');
  }

  function downloadJson(rows, stats, meta) {
    triggerDownload(buildJson(rows, stats, meta), 'subtitle-comparison.json', 'application/json;charset=utf-8');
  }

  function downloadHtmlReport(rows, stats, meta) {
    triggerDownload(buildHtmlReport(rows, stats, meta), 'subtitle-comparison-report.html', 'text/html;charset=utf-8');
  }

  function downloadSrt(cues, filename) {
    triggerDownload(buildSrt(cues), filename, 'text/plain;charset=utf-8');
  }

  global.SubtitleExport = {
    buildCsv,
    buildJson,
    buildHtmlReport,
    buildSrt,
    downloadCsv,
    downloadJson,
    downloadHtmlReport,
    downloadSrt
  };

})(typeof window !== 'undefined' ? window : globalThis);
