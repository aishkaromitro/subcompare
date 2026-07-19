# subcompare

**What it is:** a single-page web app for comparing two subtitle files (`.srt`) that are meant to line up with the same video, and finding out where their timing has drifted apart. You load "Subtitle A" and "Subtitle B", it lines them up by timestamp, and shows you a line-by-line comparison table, timing-drift graphs, and tools to fix the drift.

**How it's built:** plain HTML, CSS, and JavaScript — no frameworks (no React/Vue), no build step (no compiling or bundling), no installed dependencies. Open `index.html` directly in a browser and it works. Every file loads via a plain `<script>` tag. This was a deliberate choice: the whole thing can be understood by reading it top to bottom, there's nothing to install, and it can run offline from a folder on disk. The footer says it plainly: *"Runs entirely in your browser. No files are uploaded anywhere."*

---

## The big picture: what happens when you use it

1. **Load** — you drag in two `.srt` files. Each gets read as raw bytes, decoded to text (handling different text encodings), and parsed into a list of *cues* — one cue per subtitle line, with a start time, end time, and text.
2. **Align** — the two cue lists get matched up against each other by timestamp, using one of three algorithms you choose from. The output is a list of *rows*, where each row is `{ lineFromA, lineFromB }` — either side can be empty if that line has no counterpart in the other file.
3. **Annotate** — each row gets a computed timing difference, a quality label (Excellent/Good/Poor/Bad), and a word-level text diff (so you can see exactly which words changed, not just that the line is different).
4. **Show** — a stats panel, two graphs (timing difference per line, and cumulative drift across the file), and the full comparison table with search/filter/sort.
5. **Fix** *(optional)* — tools to correct the two files against each other: edit text inline, bulk find-and-replace on text, copying timecodes from one file onto the other, or "point sync" (pick 1+ known-correct correspondences and have the software work out the correction for every other line).
6. **Export** — download either file back out as a `.srt`, picking up any edits you made along the way.

---

## Why it's organized the way it is

The code is split into **one file per responsibility**, and there's a strict rule about how they're allowed to depend on each other:

- Every file except `app.js` is a **pure logic module**: it does one job (parsing, aligning, diffing, drawing a chart, etc.), takes plain data in, gives plain data back, and never touches the page directly. This means each one can be tested on its own, without a browser, just by calling its functions with sample data — which is exactly how this app's logic has been verified throughout development (there's no real browser test suite here, so each change has been checked by running the relevant module directly and asserting on its output).
- **`app.js` is the only file allowed to know about the page itself** (element IDs, click handlers, etc.). It's the "wiring" layer: it holds the one source of truth for what's currently loaded/selected/shown (called `state`), and it's the only place that calls into the other modules and pushes their results into the page.
- Every module attaches itself to one global name (e.g. `SubtitleParser`, `Alignment`, `SubtitleUI`) rather than using imports/exports, because there's no build step to make ES module imports convenient across plain `<script>` tags. Load order in `index.html` matters because of this — a file can only use another module's global if that module's `<script>` tag appears earlier.

This is a small, deliberate architecture: it optimizes for "any single file is easy to read and change in isolation" over "maximum code reuse" or "framework conventions."

---

## File manifest

| File | Role |
|---|---|
| `index.html` | Page structure — all the panels, inputs, and buttons. Loads every script in dependency order. |
| `style.css` | All visual styling. Light, macOS-style theme (see *Visual design* below). |
| `parser.js` | Turns a raw `.srt` file into a list of cue objects. |
| `alignment.js` | Two of the three algorithms that match Subtitle A's lines against Subtitle B's lines by time. |
| `dtw.js` | The third matching algorithm (Dynamic Time Warping), registered into `alignment.js`'s dispatcher. |
| `diff.js` | Word-level text comparison between two matched lines (what changed, not just that it changed). |
| `statistics.js` | Turns the matched rows into the numbers shown in the stats panel, the graph data, and plain-English drift suggestions. |
| `sync.js` | The logic behind the timing-fix tools: copying timecodes across, and "point sync" (shift/stretch to align chosen points). |
| `findreplace.js` | Bulk find-and-replace across one file's text, with optional regex. |
| `graphs.js` | Draws the two charts on `<canvas>`, using the page's own CSS colors so they always match the theme. |
| `scrubber.js` | Draws the clickable time-axis next to the table (see *Reading the results* below). |
| `export.js` | Turns a cue list back into downloadable `.srt` text. |
| `ui.js` | Builds the actual HTML for the stats cards and the comparison table; also the plain filter/search/sort logic. |
| `app.js` | Wires everything above to the page: owns app state, event listeners, and the overall flow. |

---

## The core data shapes

These three shapes flow through almost the entire app, so they're worth knowing:

**A cue** (one subtitle line, from either file):
```
{ index, startMs, endMs, text, lines }
```
`startMs`/`endMs` are the timing, always converted to plain milliseconds internally (never left as `"00:01:23,456"` strings) so the alignment algorithms can just do arithmetic. `index` is the number the line had in the original file — kept only for display, **deliberately never used for matching**, because two out-of-sync files will have mismatched numbering even when the timing is fine. `text`/`lines` are the caption text, as one string and as an array of lines.

**A row** (one entry in the comparison table, after alignment):
```
{ id, a: cueOrNull, b: cueOrNull, diffMs, quality, htmlA, htmlB, textDiff }
```
`a`/`b` are the matched cue from each file (or `null` if this line has no counterpart on that side — this is how "missing in the other file" is represented). Critically, `a`/`b` are **the same object instances** as in the original loaded file's cue list, not copies — so editing a row's text, or changing its timing via a sync tool, directly mutates the underlying cue. That's what lets "export as .srt" pick up every edit automatically, with no separate bookkeeping.

**App state** (`app.js`'s single source of truth — simplified):
```
{ fileA, fileB, rows, stats, graphPoints, mode, maxVarianceMs,
  filter, search, sortKey, syncPoints, pendingSyncA, pendingSyncB, ... }
```

---

## The three alignment modes

Matching is based **purely on timing, never on text** — this is a deliberate rule stated at the top of `alignment.js`. It means the tool works just as well comparing two different-language translations of the same video as it does comparing two versions in the same language, since it never cares what the words say.

- **Nearest timestamp** — for every line in A, find whichever line in B starts closest in time. Fast, but has no sense of "too far to be a real match" on its own — a line in A with nothing corresponding in B will still get force-paired to whatever's nearest, unless a variance cap (below) stops it.
- **Monotonic (DP)** — a dynamic-programming algorithm (same family as sequence alignment in bioinformatics, or a classic text-diff) that matches lines in time order and is allowed to leave lines unmatched if that's cheaper than forcing a bad match. This is the default, and the best general-purpose choice.
- **Dynamic Time Warping** — like Monotonic, but the "how good is this match" score also weighs duration and time-overlap, not just start-time closeness. Better suited to files whose *line boundaries* don't match up the same way (e.g. two different translations that split the same dialogue into a different number of lines).

**Max acceptable variance** (a number of seconds, optional): a hard cutoff layered on top of all three modes. If the best possible match for a line is farther away in time than this, it's left unmatched rather than forced. This exists specifically for files that don't cover the same span of the video — e.g. one file transcribes only some sections while the other covers all of it — so the parts genuinely absent from one side don't get wrongly paired to whatever happens to be nearby.

**A known limitation worth remembering:** matching is strictly one-to-one. A row can only ever be `{one line, one line}` — there's no way to represent "these two lines in B together correspond to this one line in A." If two files split the same dialogue into a different number of lines (very common between independent translations), some genuinely-correct correspondences will still show up as "unmatched" in the table, even though the underlying timing is fine.

---

## The fix-it tools

- **Find & replace** — bulk text replacement across one file's lines, with an optional regex mode (with capture-group support, e.g. `$1`) and a case-sensitivity toggle. Works before or after aligning, since it never touches timing.
- **Copy timecodes** — for every matched row, overwrite one side's timing with the other's. Simple, but only correct when both files' lines are already segmented the same way — it assumes the row's pairing is 1:1-correct.
- **Point sync** — the tool for fixing files that are badly out of sync, where you don't trust the automatic alignment to have picked the right pairs. You manually pick a line in Subtitle A and a line in Subtitle B — independently of each other, from *anywhere* in the table, not necessarily the same row — and set that pair as a "sync point." With **one sync point**, every timestamp in the target file shifts by the same constant offset needed to line up that one pair (a pure shift, no stretching). With **two or more**, the timing is corrected as a piecewise-linear stretch: exact at each chosen point, smoothly interpolated between them, and extrapolated past the first/last point using the nearest segment's rate — so the whole file bends into alignment around your chosen anchors, not just the portion between them.

---

## Reading the results

- **Quality (Excellent/Good/Poor/Bad)** is based purely on the timing gap in milliseconds — it's completely independent of whether the text matches, so it stays meaningful even comparing two different languages.
- **The word-level diff** (colored strikethrough/underline in the text columns) shows exactly which words changed between two matched lines — useful for spotting near-duplicate translations, but expected to show "everything different" when comparing two genuinely different languages.
- **The drift graphs and plain-English suggestions** ("Subtitle B appears delayed by 1.4 seconds", frame-rate mismatch warnings) are computed only from matched rows, so unmatched lines (including ones deliberately excluded by the variance cap) don't skew them.
- **The time scrubber** next to the table is a compressed, clickable/draggable time axis (with tick marks every 30 minutes) — click or drag anywhere on it to jump straight to that point in a long file, rather than scrolling. It shows a highlighted band for whatever portion of the file is currently in view.

---

## Visual design

Light, native-macOS-inspired theme: white/near-white panels, macOS system blue (`#007AFF`) as the one accent color used for every primary action, monospace type for anything that's a number or timestamp. All colors are defined once as CSS custom properties and reused everywhere — including inside the `<canvas>`-drawn graphs and scrubber, which read the live CSS values at draw time rather than hard-coding a second copy of the palette, so the charts can never visually drift out of sync with the rest of the page.

---

## Things worth keeping in mind for future changes

- No build tools, no package manager, no test framework — verifying a change means either exercising it in an actual browser, or (as has been the practice throughout this project) loading the relevant module directly and calling its functions with sample data to check the output.
- Every pure-logic module is written so it *can* be exercised that way: no DOM access, plain functions in, plain data out.
- `app.js` is intentionally the only file that knows about specific element IDs — if a feature needs new UI, the pattern is: add the markup to `index.html`, add any drawing/formatting logic to the relevant pure module, and wire it up from `app.js`.
- The one-to-one row-matching limitation (above) is structural, not a bug — worth remembering before adding features that assume every line has exactly one counterpart.
- This is a personal-use tool, not a distributed product — no installer, no auto-update, no analytics, and features have been built assuming a technically comfortable single user rather than a general audience.
