/* ==========================================================================
   findreplace.js
   Responsibility: bulk find-and-replace across a single subtitle file's
   cue text, with optional regex support. Pure logic only — no DOM.
   app.js decides which file's cues to pass in, when to confirm with the
   user, and re-renders/re-annotates afterward (timing is never touched
   here, so no re-alignment is needed — only the diff/table view, which
   reads cue.text, needs a refresh).
   ========================================================================== */

(function (global) {
  'use strict';

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Builds the RegExp used to search cue text. Throws (with the native
   * SyntaxError message) if `useRegex` is true and `find` isn't a valid
   * pattern — callers should catch this and surface it to the user
   * rather than let it propagate as an unhandled error.
   * @param {string} find
   * @param {{useRegex?: boolean, caseSensitive?: boolean}} [options]
   */
  function buildPattern(find, options) {
    const opts = options || {};
    const flags = 'g' + (opts.caseSensitive ? '' : 'i');
    const source = opts.useRegex ? find : escapeRegExp(find);
    return new RegExp(source, flags);
  }

  /**
   * Read-only pass: counts matches without touching cue text. Used to
   * show the user what a replacement would affect before committing to
   * it.
   * @returns {{matchCount: number, cueCount: number}}
   */
  function countMatches(cues, pattern) {
    let matchCount = 0;
    let cueCount = 0;
    for (const cue of cues) {
      const matches = cue.text.match(pattern);
      if (matches && matches.length) {
        matchCount += matches.length;
        cueCount++;
      }
    }
    return { matchCount, cueCount };
  }

  /**
   * Replaces every match of `pattern` in every cue's text, in place.
   * `replacement` supports standard JS replace-string syntax ($1, $2, …)
   * for referencing regex capture groups.
   * @returns {{matchCount: number, cueCount: number}}
   */
  function replaceInCues(cues, pattern, replacement) {
    let matchCount = 0;
    let cueCount = 0;
    for (const cue of cues) {
      const matches = cue.text.match(pattern);
      if (!matches || matches.length === 0) continue;
      matchCount += matches.length;
      cueCount++;
      cue.text = cue.text.replace(pattern, replacement);
      cue.lines = cue.text.split('\n');
    }
    return { matchCount, cueCount };
  }

  global.SubtitleFindReplace = {
    escapeRegExp,
    buildPattern,
    countMatches,
    replaceInCues
  };

})(typeof window !== 'undefined' ? window : globalThis);
