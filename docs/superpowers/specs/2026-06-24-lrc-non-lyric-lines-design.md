# Filter Non-Lyric LRC Lines (Speaker Labels & Section Headers) — Design

**Date:** 2026-06-24
**Status:** Design approved (brainstorming); pending implementation plan.
**Scope:** lyric ingestion only — a pure filter at the `parseLrc` choke point. No change to the scoring engine, phrase plan, or HUD. Affects every song (the deployed static path and the local-dev Python path).
**Motivation:** real telemetry (Class of 3000 — We Want Your Soul, 2026-06-25 run) shows LRC files contain non-lyric annotations — rap-battle / dialogue **speaker labels** — that the engine treats as required-to-sing lines. They are physically un-singable (nobody voices them), so they can only ever be missed.

---

## 1. Problem

LRC lyric files from lrclib.net sometimes carry lines that are **annotations, not lyrics**. In a dialogue/rap-battle song the LRC marks *who* is performing with a speaker label on its own timestamped line. The player ingests every timestamped line as a singable lyric, builds anchors for it, and then waits for the user to sing a character's name that is never voiced in the audio.

### Evidence (telemetry: `karaokee-telemetry-2026-06-25T03-39-51.json`)
Song "Class of 3000 — We Want Your Soul", 82 LRC lines, browser-SR. Four "lines" are speaker labels:

| lineIdx | text (as scored) | startSec | outcome |
|--------:|------------------|---------:|---------|
| 4  | `shawty e demoni` | 19.13 | 0/2 anchors → missed |
| 12 | `lild`            | 41.31 | 0/1 anchors → missed |
| 21 | `shawty e demoni` | 63.00 | 1/2 anchors → missed |
| 31 | `lild`            | 82.03 | 0/1 anchors → missed |

The run had **7 missed lines total; 4 of those 7 (57%) are these un-singable labels.** Each one is impossible to clear, drags down the honest-% headline, and breaks the combo chain mid-song. The engine even assigned anchor weights (`demoni` 1.35, `shawty` 1.15) — it was actively scoring a speaker name.

### Root signal (raw LRC, pulled from lrclib)
Both labels carry a **trailing colon** in the source data:

```
[00:19.13] Shawty e demoni:
[00:41.31] Lil'D:
[01:03.00] Shawty e demoni:
[01:22.03] Lil'D:
```

These are the **only** colon-bearing lines in the song. Real mentions of the same names inside sung lines do **not** end in a colon (`Ah Lil D! Welcome to "soul stack records".`, `Get em Shawty`, `Soul? Shawty I got that`), so a trailing-colon rule isolates exactly the four phantom lines with zero false positives here. This is the same family as the "merged-word LRC data … a lyric-data-quality problem" called out as a separate track in [the anchor-selection-quality design §2](2026-06-05-anchor-selection-quality-design.md). Related: [[in-app-search-shipped]].

The fix point is `parseLrc()` in [lyrics-client.js:10](../../../static/lyrics-client.js) — the single client choke point where raw LRC becomes `[{time,text}]`, consumed by **both** the search preview (`searchSongs`) and the game (`fetchLyrics`). The dev/server path is the mirror `parse_lrc()` in [lyrics.py:12](../../../lyrics.py).

## 2. Goals / Non-goals

**Goals**
- Drop whole-line **speaker labels** (trailing colon) from ingested lyrics — gone from both display and scoring.
- Drop whole-line **section headers** (`[Chorus]`, `(Verse 1)`, …) from ingested lyrics.
- Zero (or near-zero) false positives: never strip a line the user actually sings.
- Pure, DOM-free, `.cjs`-testable logic following the helper-module pattern (`profanity.js`, `metadata-clean.js`).
- Keep JS (production) and Python (dev) parsers in parity.

**Non-goals (explicitly out of scope)**
- **Inline `Name:` prefixes** (`Lil D: Soul shawty I got that` on one line). Higher false-positive risk (timestamps `3:30`, `she said:`); this song puts labels on their own line, so whole-line handling fully covers it. Deferred.
- **Showing labels as a non-scored "who's singing" cue.** Considered; user chose drop-entirely. A future enhancement could re-introduce them as styled, never-scored cues.
- **Parenthetical content stripping in general.** Backing vocals like `(Soul) Ah ah ah ah!` are sung and must be kept — only *fully-wrapped section-keyword* lines are removed.
- **Any scoring/anchor/HUD change.** This is purely an ingestion filter; fewer lines flow downstream, nothing else moves.

## 3. Design

### New pure helper `static/lyric-annotations.js` (`window.KaraokeeLyricAnnotations`)
UMD-wrapped (browser `<script>` global + Node `require`), DOM-free. Exports:

#### `isSpeakerLabel(text) → bool`
True when the line is a bare speaker tag:
- trimmed text **ends with `:`**, and
- the text before the colon has **≤ `MAX_SPEAKER_LABEL_WORDS` (4)** whitespace-separated words, and
- **none** of those words is in a small `SENTENCE_STOPWORDS` set (`and, then, the, to, of, in, is, are, was, were, she, he, we, you, it, that, this, but, so, with, my, your, a, i`).

Rationale for the guards: the word cap rejects long sentences that happen to end in a colon; the stopword guard keeps a real lyric like `and then she said:` (contains `and`/`then`/`she`) while still dropping `Shawty e demoni:` (no stopword) and `Lil'D:` (one token). Both guards err toward *keeping* a line — under-filtering a genuine label is safer than stripping a real lyric. `MAX_SPEAKER_LABEL_WORDS` and the stopword set are named constants, tunable against the golden corpus.

#### `isSectionHeader(text) → bool`
True when the **entire** line is a single section tag:
- matches `^[[({]\s*([^[\](){}]+?)\s*[\])}]$` — one balanced `[]` / `()` / `{}` wrap, **no inner brackets** (so the wrap spans the whole line), and
- the inner text's first token (after dropping an optional trailing number / `xN` / roman numeral, e.g. `verse 1`, `chorus 2x`) is in `SECTION_KEYWORDS` (`intro, verse, chorus, pre-chorus, prechorus, post-chorus, bridge, outro, hook, refrain, interlude, breakdown, drop, instrumental, solo, vamp, coda, spoken`).

Rationale: the full-wrap requirement keeps `(Soul) Ah ah ah ah!` (ends in `!`, not a wrap) and `(I Can't Get No) Satisfaction` (text continues past the paren). The keyword-vocabulary requirement keeps sung parentheticals that *are* fully wrapped but aren't sections — `(Ooh)`, `(Soul)`, `(La la la)`. Both conditions must hold to drop.

#### `isNonLyricLine(text) → bool`
`isSpeakerLabel(text) || isSectionHeader(text)`.

#### `stripNonLyricLines(lines) → lines`
Filters a `[{time,text}]` list via `isNonLyricLine`. **Fail-safe:** if the filtered list is empty but the input was non-empty, return the **original** list unchanged — never serve an empty lyric sheet (guards a malformed all-annotation file or an over-broad rule).

### Integration
- `parseLrc()` in [lyrics-client.js:10](../../../static/lyrics-client.js): build the `lines` array as today, then `return stripNonLyricLines(lines)`. Both `searchSongs` (preview) and `fetchLyrics` (game) inherit the clean list from this one call. `lyric-annotations.js` loads before `lyrics-client.js` (script order in `index.html` / `player.html`); under Node it is `require`d.
- `parse_lrc()` in [lyrics.py:12](../../../lyrics.py): mirror the same two predicates and the fail-safe in Python so the local-dev `/load-local` / `/retry-lyrics` path and `test_lyrics.py` stay in parity with production. The constants/keyword lists are duplicated by necessity (no shared runtime); the `.cjs` and pytest golden corpora must assert the **same** cases so drift is caught.

## 4. Module boundaries (testability)
All logic is pure and `.cjs`-tested. New `tests/test_lyric_annotations.cjs`, golden cases drawn from the real song:

- **`isSpeakerLabel`** — drop: `Shawty e demoni:`, `Lil'D:`. keep: `and then she said:` (stopword), `Soul? Shawty I got that` (no colon), `Ah Lil D! Welcome to "soul stack records".` (no colon), a long colon-ending sentence (word cap).
- **`isSectionHeader`** — drop: `[Chorus]`, `(Verse 1)`, `[Bridge]`, `(Intro)`, `{Hook}`, `(Pre-Chorus 2)`. keep: `(Soul) Ah ah ah ah!`, `(I Can't Get No) Satisfaction`, `(Ooh)`, `(Soul)` (fully wrapped but not a section word).
- **`stripNonLyricLines`** — removes exactly the annotation lines from a mixed list; **fail-safe** returns the original when every line is an annotation.
- **Python parity** — `tests/test_lyrics.py` (or a sibling) asserts the same drop/keep set against `parse_lrc`.

## 5. Validation (evidence before completion)
1. **Automated:** new `.cjs` golden tests + Python parity tests green; existing `test_lyrics_search.cjs` / `test_lyrics.py` still green (preview/parse contract unchanged except annotation removal).
2. **Real-LRC assertion:** a script runs the patched `parseLrc` against the actual lrclib LRC for this song and asserts **82 → 78 lines**, the four label lines are absent, and every negative case above survives — i.e., the 4-of-7 phantom misses cannot recur.
3. **Spot-check breadth:** run the filter over a handful of other lrclib LRCs (a normal pop song with no annotations → unchanged line count; a song with `[Verse]/[Chorus]` headers → headers gone, lyrics intact) to confirm no collateral stripping.

## 6. Risks
- **Speaker-label false positive** — a real lyric that is ≤4 words, ends in a colon, and contains no stopword (e.g. a bare `Hello:`). Rare; mitigated by the stopword guard and the fail-safe. Tunable via `MAX_SPEAKER_LABEL_WORDS` / stopword set against the corpus.
- **Section-keyword false positive** — a fully-wrapped line whose first word collides with the vocabulary (e.g. a song with a sung `(Bridge)` as an actual word). Very rare; accepted, vocabulary is editable.
- **JS/Python drift** — duplicated constants could diverge. Mitigated by asserting identical golden cases in both test suites.
- **Under-filtering** — an unusual annotation style (no colon, no brackets) slips through. Acceptable: this design targets the two dominant forms; inline prefixes and exotic styles are explicit non-goals.

## 7. Rollout
- Branch `feat/filter-non-lyric-lrc-lines`.
- No flag — ingestion filter on the single live scoring path (V1 is retired; arcade is the sole path).
- Sequence (TDD): write `tests/test_lyric_annotations.cjs` golden cases → implement `static/lyric-annotations.js` to green → wire into `parseLrc` (+ load order in `index.html`/`player.html`) → mirror in `lyrics.py` + Python parity test → real-LRC assertion script (82→78) → spot-check breadth → done.
