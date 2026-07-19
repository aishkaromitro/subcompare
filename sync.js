/* ==========================================================================
   sync.js
   Responsibility: timecode-editing operations that a user triggers
   explicitly (as opposed to alignment.js/dtw.js, which only ever READ
   timecodes to decide matches). Two operations:

     - copyTimecodes(rows, direction)   — for every matched row, overwrite
       one side's startMs/endMs with the other side's, in place.

     - buildPointSyncMapper(anchors) / applyPointSync(cues, anchors) —
       classic subtitle "point sync": the caller supplies 1+ (from, to)
       time anchors (e.g. "this line's current time" -> "the time it
       should have"), and every cue's startMs/endMs is remapped through
       the function those anchors define.
         - 1 anchor: no second point to derive a scale from, so this is
           a pure shift — every timestamp moves by the same constant
           offset needed to land that one anchor exactly on target.
         - 2+ anchors: a piecewise-linear function. Between two anchors
           the mapping is a straight line (linear interpolation);
           outside the outermost anchors it's extrapolated using the
           slope of the nearest segment, so the whole file shifts and
           stretches around the chosen points rather than only the
           bracketed portion. With exactly 2 anchors this degenerates
           to the traditional single shift+scale two-point sync.

   Pure logic only — no DOM. app.js decides which cues/rows to pass in
   and re-runs alignment afterwards, since every cue on the target side
   moved.
   ========================================================================== */

(function (global) {
  'use strict';

  /**
   * Copies startMs/endMs across every row that has both an `a` and `b`
   * cue. Mutates the destination cue objects in place (same objects
   * referenced by state.fileA.cues / state.fileB.cues, per the pattern
   * already used by inline text editing in app.js).
   * @param {Array} rows - annotated alignment rows
   * @param {'aToB'|'bToA'} direction - which side's timing wins
   * @returns {number} how many rows were updated
   */
  function copyTimecodes(rows, direction) {
    let count = 0;
    for (const row of rows) {
      if (!row.a || !row.b) continue;
      if (direction === 'aToB') {
        row.b.startMs = row.a.startMs;
        row.b.endMs = row.a.endMs;
      } else {
        row.a.startMs = row.b.startMs;
        row.a.endMs = row.b.endMs;
      }
      count++;
    }
    return count;
  }

  /**
   * Builds a time-remapping function from a list of {from, to} anchors
   * (both in ms). Anchors are sorted and deduplicated by `from` before
   * use. A single anchor produces a constant-shift function; 2+ produce
   * a piecewise-linear one (see the module doc comment above).
   * @param {Array<{from:number, to:number}>} anchors
   * @returns {(t:number) => number}
   */
  function buildPointSyncMapper(anchors) {
    const points = [...anchors]
      .sort((p1, p2) => p1.from - p2.from)
      .filter((p, idx, arr) => idx === 0 || p.from !== arr[idx - 1].from);

    if (points.length === 0) {
      throw new Error('Point sync needs at least 1 sync point.');
    }

    if (points.length === 1) {
      const shift = points[0].to - points[0].from;
      return function map(t) {
        return t + shift;
      };
    }

    const segments = [];
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i], p1 = points[i + 1];
      const slope = (p1.to - p0.to) / (p1.from - p0.from);
      segments.push({ fromStart: p0.from, fromEnd: p1.from, toStart: p0.to, slope });
    }
    const first = segments[0];
    const last = segments[segments.length - 1];

    return function map(t) {
      if (t <= points[0].from) return first.toStart + first.slope * (t - first.fromStart);
      if (t >= points[points.length - 1].from) return last.toStart + last.slope * (t - last.fromStart);
      for (const seg of segments) {
        if (t >= seg.fromStart && t <= seg.fromEnd) {
          return seg.toStart + seg.slope * (t - seg.fromStart);
        }
      }
      return t; // unreachable given the bounds checks above
    };
  }

  /**
   * Remaps every cue's startMs/endMs in place through the mapper built
   * from `anchors`. Results are rounded to the nearest ms and clamped
   * so startMs/endMs never go negative or invert.
   * @param {Array} cues - cues to remap in place (one file's whole cue list)
   * @param {Array<{from:number, to:number}>} anchors
   */
  function applyPointSync(cues, anchors) {
    const map = buildPointSyncMapper(anchors);
    for (const cue of cues) {
      const newStart = Math.max(0, Math.round(map(cue.startMs)));
      const newEnd = Math.max(newStart, Math.round(map(cue.endMs)));
      cue.startMs = newStart;
      cue.endMs = newEnd;
    }
  }

  global.SubtitleSync = {
    copyTimecodes,
    buildPointSyncMapper,
    applyPointSync
  };

})(typeof window !== 'undefined' ? window : globalThis);
