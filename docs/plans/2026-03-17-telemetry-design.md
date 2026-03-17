# Karaokee Telemetry System — Design

**Date:** 2026-03-17
**Status:** Approved

## Goal

Capture structured, per-event diagnostic data during game mode so that precise numerical analysis can be performed on lyric-detection accuracy, match method breakdown, transition timing, and tempo-correlated behaviour — with the output pasted directly into a Claude conversation for deep analysis.

## Approach

Rich JSON telemetry log, recorded in-memory during play, auto-downloaded as a `.json` file when the song ends. Active only when debug mode is on (`D` key / `window._kDebug === true`). No server changes required.

## Data Schema

Single JSON object with four top-level keys:

### `meta` — captured once at `startGame()`

```json
{
  "songTitle": "Lose Yourself",
  "songDurationMs": 326000,
  "lrcLines": 42,
  "whisperAvailable": true,
  "browserLang": "en-US",
  "startedAt": "2026-03-17T14:32:00Z",
  "gameVersion": "1.0"
}
```

`songDurationMs` enables per-line coverage normalisation and anomaly detection relative to total song length.

### `asr[]` — one entry per speech recognition result

```json
{
  "ts": 12.34,
  "lineIdx": 5,
  "lineTempo": "fast",
  "type": "final",
  "text": "his palms are sweaty",
  "wordTimestamps": [{ "word": "his", "start": 11.9, "end": 12.1 }]
}
```

`type` is `"final"` or `"interim"`. `wordTimestamps` is populated only when Whisper word-level timestamps are available.

### `matches[]` — one entry per word-match attempt (richest dataset)

```json
{
  "ts": 12.45,
  "lineIdx": 5,
  "lineTempo": "fast",
  "spokenWord": "palms",
  "targetWord": "palms",
  "method": "exact",
  "editDistance": 0,
  "phoneticMatch": true,
  "score": 1.0,
  "matched": true,
  "windowPosition": 2
}
```

`method` is one of: `"exact"`, `"fuzzy"`, `"phonetic"`, `"phrase"`, `"contraction"`, `"none"` (attempted but unmatched).
`windowPosition` is the index within the current spoken window at which the match was attempted.

Cap: 5,000 entries. Once reached, new attempts update aggregate counts only.

### `transitions[]` — one entry per line advance

```json
{
  "ts": 15.20,
  "fromIdx": 5,
  "toIdx": 6,
  "fromText": "his palms are sweaty knees weak arms are heavy",
  "trigger": "score",
  "matchedWords": 7,
  "totalWords": 9,
  "missedWords": ["knees", "heavy"],
  "timeSpentMs": 4200,
  "lineTempo": "fast",
  "expectedTimeMs": 4000,
  "earlyMs": null,
  "lateMs": 200
}
```

`trigger` is `"score"` (threshold met), `"time"` (clock expired), or `"forced"` (song ended).
`earlyMs` / `lateMs` — exactly one will be non-null, showing how far off the transition was vs the LRC timestamp.

## Tempo Classification

Reuses existing `getSpokenWindowSize` thresholds from `sync-helpers.js`. Each event is tagged `"slow"`, `"medium"`, or `"fast"` at log time — no new logic.

## Architecture

All changes are inside the existing `GameMode` class in `static/player.js`. No new files except a test file.

| Addition | Purpose |
|---|---|
| `this._telemetry` | In-memory log object, initialised at `startGame()`, null otherwise |
| `_logAsr(type, text, wts)` | Called at existing ASR result sites |
| `_logMatch(spoken, target, method, ed, phonetic, score, matched, pos)` | Called at match-helpers call sites |
| `_logTransition(fromIdx, toIdx, trigger, ...)` | Called in existing line-advance path |
| `_downloadTelemetry()` | Serialises to JSON blob and triggers browser download |

## Download Triggers

1. **Auto-download** when song naturally ends (existing end-of-song hook)
2. **`📥` button** in the debug HUD — visible only when `window._kDebug === true`

Filename: `karaokee-telemetry-<songTitle>-<timestamp>.json`

## Error Handling

- All `_log*` calls wrapped in `try/catch` — logging failures never crash the game
- If `_telemetry` is null, all log calls are no-ops
- If blob download fails, raw JSON is printed to `console.warn` for manual copy

## Testing

- New `tests/test_telemetry.cjs`: schema shape, all four keys present, `lineTempo` always one of three valid values, 5,000-entry cap logic
- Existing `tests/test_match_helpers.cjs` — unchanged, matching logic already covered
- Manual: play one song with `D` pressed, confirm download, paste JSON for analysis
