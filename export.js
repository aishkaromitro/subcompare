/* ==========================================================================
   export.js
   Responsibility: turn a subtitle file's cues (possibly carrying inline
   edits made in the table, or timecodes rewritten by the sync tools)
   back into a downloadable .srt file.

   Split deliberately into a pure "build*" function (returns a string,
   fully unit-testable without a browser) and a thin "download*" wrapper
   that does the actual Blob/anchor-click dance. app.js only ever calls
   the download* function.
   ========================================================================== */

(function (global) {
  'use strict';

  const P = () => global.SubtitleParser; // lazy lookup, avoids load-order coupling

  /**
   * Serializes a cue array (e.g. state.fileA.cues) back into standard
   * SRT text. Cue indices are renumbered sequentially — the original
   * numbering from the source file isn't meaningful after edits and may
   * have gaps, so a clean 1..N sequence is the only thing worth writing
   * out.
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

  function downloadSrt(cues, filename) {
    triggerDownload(buildSrt(cues), filename, 'text/plain;charset=utf-8');
  }

  global.SubtitleExport = {
    buildSrt,
    downloadSrt
  };

})(typeof window !== 'undefined' ? window : globalThis);
