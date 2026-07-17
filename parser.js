/* ==========================================================================
   parser.js
   Responsibility: turn a raw file (bytes) into a normalized array of
   subtitle cue objects: { index, startMs, endMs, text, lines }.

   Design notes:
   - Subtitle NUMBERING from the file is read but never relied upon for
     comparison — only used for display / debugging.
   - Encoding detection (UTF-8 / UTF-16 LE / UTF-16 BE, with or without
     BOM) happens on the raw ArrayBuffer before any text parsing.
   - Format parsing is pluggable via the FORMAT_PARSERS registry so
     VTT / ASS support can be added later without touching this file's
     public API (see registerFormatParser at the bottom).
   ========================================================================== */

(function (global) {
  'use strict';

  /* ---------------------------------------------------------------------
   * Encoding detection + decoding
   * ------------------------------------------------------------------- */

  /**
   * Inspects the first bytes of an ArrayBuffer to detect a BOM and
   * therefore the likely text encoding.
   * @param {ArrayBuffer} buffer
   * @returns {{encoding: string, bomLength: number}}
   */
  function detectEncoding(buffer) {
    const bytes = new Uint8Array(buffer.slice(0, 4));

    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return { encoding: 'utf-8', bomLength: 3 };
    }
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return { encoding: 'utf-16le', bomLength: 2 };
    }
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
      return { encoding: 'utf-16be', bomLength: 2 };
    }

    // No BOM. Heuristic: UTF-16 text (ASCII-range content) shows a very
    // regular pattern of null bytes in every other position. Sample the
    // first chunk to guess LE vs BE vs UTF-8.
    const sample = new Uint8Array(buffer.slice(0, Math.min(buffer.byteLength, 200)));
    let evenZero = 0, oddZero = 0;
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] === 0) { (i % 2 === 0) ? evenZero++ : oddZero++; }
    }
    const total = sample.length;
    if (total > 8) {
      if (oddZero / total > 0.3) return { encoding: 'utf-16le', bomLength: 0 };
      if (evenZero / total > 0.3) return { encoding: 'utf-16be', bomLength: 0 };
    }

    return { encoding: 'utf-8', bomLength: 0 };
  }

  /**
   * Decodes an ArrayBuffer to a JS string using the detected encoding.
   * @param {ArrayBuffer} buffer
   * @returns {string}
   */
  function decodeBuffer(buffer) {
    const { encoding, bomLength } = detectEncoding(buffer);
    const view = buffer.slice(bomLength);
    const decoder = new TextDecoder(encoding);
    return decoder.decode(view);
  }

  /* ---------------------------------------------------------------------
   * Timestamp helpers
   * ------------------------------------------------------------------- */

  /**
   * Converts an SRT timestamp ("HH:MM:SS,mmm") to milliseconds.
   * Also tolerates "HH:MM:SS.mmm" (VTT-style) for forward compatibility.
   * @param {string} ts
   * @returns {number} milliseconds, or NaN if unparseable
   */
  function timeToMs(ts) {
    const m = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(ts.trim());
    if (!m) return NaN;
    const [, hh, mm, ss, ms] = m;
    const msPadded = ms.padEnd(3, '0');
    return (
      parseInt(hh, 10) * 3600000 +
      parseInt(mm, 10) * 60000 +
      parseInt(ss, 10) * 1000 +
      parseInt(msPadded, 10)
    );
  }

  /**
   * Converts milliseconds back to an SRT-style timestamp string.
   * @param {number} ms
   * @returns {string} "HH:MM:SS,mmm"
   */
  function msToTime(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    ms = Math.round(ms);
    const hh = Math.floor(ms / 3600000);
    ms -= hh * 3600000;
    const mm = Math.floor(ms / 60000);
    ms -= mm * 60000;
    const ss = Math.floor(ms / 1000);
    ms -= ss * 1000;
    const pad = (n, l) => String(n).padStart(l, '0');
    return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)},${pad(ms, 3)}`;
  }

  /* ---------------------------------------------------------------------
   * SRT parsing
   * ------------------------------------------------------------------- */

  /**
   * Parses SRT text into an array of cue objects.
   * Handles: CRLF/LF/CR line endings, blank-line-separated blocks,
   * multi-line subtitle text, and stray blank lines inside a file.
   * @param {string} text
   * @returns {Array<{index:number, startMs:number, endMs:number, text:string, lines:string[]}>}
   */
  function parseSRT(text) {
    const cues = [];

    // Normalize all line endings to \n, then split into blocks on
    // one-or-more blank lines.
    const normalized = text.replace(/\r\n?/g, '\n').trim();
    if (!normalized) return cues;

    const blocks = normalized.split(/\n\s*\n/);
    const timeLineRe = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;

    for (const block of blocks) {
      const lines = block.split('\n').map(l => l.trim()).filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
      if (lines.length === 0) continue;

      // Find the timing line within the block — usually line 0 or 1
      // (line 0 is often a numeric index, which we ignore for matching
      // but keep for display).
      let timeLineIdx = -1;
      let rawIndex = null;
      for (let i = 0; i < Math.min(lines.length, 3); i++) {
        if (timeLineRe.test(lines[i])) { timeLineIdx = i; break; }
      }
      if (timeLineIdx === -1) continue; // malformed block, skip

      if (timeLineIdx > 0 && /^\d+$/.test(lines[0])) {
        rawIndex = parseInt(lines[0], 10);
      }

      const match = timeLineRe.exec(lines[timeLineIdx]);
      const startMs = timeToMs(match[1]);
      const endMs = timeToMs(match[2]);
      const textLines = lines.slice(timeLineIdx + 1);

      cues.push({
        index: rawIndex !== null ? rawIndex : cues.length + 1,
        startMs,
        endMs,
        text: textLines.join('\n'),
        lines: textLines
      });
    }

    // Ensure output is ordered by start time regardless of source order —
    // downstream alignment relies on ascending timestamps.
    cues.sort((a, b) => a.startMs - b.startMs);
    return cues;
  }

  /* ---------------------------------------------------------------------
   * Format detection + pluggable registry
   * ------------------------------------------------------------------- */

  const FORMAT_PARSERS = {
    srt: parseSRT
    // vtt: parseVTT,   <- future
    // ass: parseASS,   <- future
  };

  /**
   * Registers a new format parser at runtime, e.g. from a future
   * vtt.js module: SubtitleParser.registerFormatParser('vtt', parseVTT)
   */
  function registerFormatParser(formatName, parserFn) {
    FORMAT_PARSERS[formatName] = parserFn;
  }

  /**
   * Guesses a subtitle format from filename extension, falling back to
   * content sniffing.
   */
  function detectFormat(filename, text) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (FORMAT_PARSERS[ext]) return ext;
    if (/^WEBVTT/m.test(text)) return 'vtt';
    if (/\d+\s*\n\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(text)) return 'srt';
    return 'srt'; // default best-effort
  }

  /**
   * Full pipeline: File -> decoded text -> parsed cues.
   * @param {File} file
   * @returns {Promise<{cues: Array, format: string, encoding: string, filename: string}>}
   */
  function parseFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Could not read file "${file.name}".`));
      reader.onload = () => {
        try {
          const buffer = reader.result;
          const { encoding } = detectEncoding(buffer);
          const text = decodeBuffer(buffer);
          const format = detectFormat(file.name, text);
          const parserFn = FORMAT_PARSERS[format];
          if (!parserFn) {
            reject(new Error(`No parser available for format ".${format}".`));
            return;
          }
          const cues = parserFn(text);
          if (cues.length === 0) {
            reject(new Error(`"${file.name}" was read but no valid subtitle cues were found.`));
            return;
          }
          resolve({ cues, format, encoding, filename: file.name });
        } catch (err) {
          reject(err);
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /* ---------------------------------------------------------------------
   * Public API
   * ------------------------------------------------------------------- */

  global.SubtitleParser = {
    detectEncoding,
    decodeBuffer,
    timeToMs,
    msToTime,
    parseSRT,
    detectFormat,
    parseFile,
    registerFormatParser
  };

})(typeof window !== 'undefined' ? window : globalThis);
