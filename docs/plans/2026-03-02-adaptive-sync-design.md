# Adaptive Sync & Soft Boundaries Design

**Date:** 2026-03-02
**Goal:** Improve detection reliability across all tempos (ballads to fast rap), fix premature line cutoff at any line transition, and reduce latency on fast sections.

## Problem Statement

Three related issues:

1. **Line transitions cut off words** — the hard fence reset in `setActiveLine()` destroys the old line's matching context immediately. The 800ms late-score delay with -4 word lookback is a fragile second-chance mechanism that fails on fast songs.
2. **Fast songs produce mixed failures** — words never match, match late, or match on the wrong line. Fixed constants (window sizes, drift, chunk size) don't adapt to tempo.
3. **Back-to-back fast bars** — ASR latency (200-600ms for Web Speech, 2s+ for Whisper) means results arrive after the line has already transitioned, and the fence blocks them.

## Approach

**Approach 1 + selective Approach 3:** Adaptive constants based on per-line tempo, soft line boundaries with overlap zones, and dynamic Whisper chunk sizing for fast sections.

## Design

### 1. Tempo Analysis & Line Classification

Extend `interpolateWordTimings()` to compute per-line tempo metrics.

**Computed per line:**
- `wordsPerSecond` = word count / line duration
- `tempoClass` = slow | normal | fast

| Class    | WPS Range | Examples                              |
|----------|-----------|---------------------------------------|
| `slow`   | < 2.0     | Ballads, sustained notes, sparse lines |
| `normal` | 2.0 – 5.0 | Pop, rock, most singing               |
| `fast`   | > 5.0     | Rap, fast-patter, spoken word          |

Stored on the existing `wordTimings` line metadata. Computed once at lyrics load — zero runtime cost.

**Last-line edge case:** Use `audio.duration` when available (clamped to max 8s) instead of the current `lineStart + 4.0s` fallback.

### 2. Adaptive Time Windows

Scale matching window constants based on `tempoClass`.

| Constant         | `slow` | `normal` | `fast` |
|------------------|--------|----------|--------|
| `windowStart`    | -0.3s  | -0.3s    | -0.5s  |
| `windowEnd`      | +1.5s  | +1.5s    | +2.5s  |
| Drift (Track 1)  | 14     | 18       | 25     |
| Drift (Track 2)  | 12     | 15       | 20     |

**Rationale:**
- Fast lines: words ~125ms apart, ASR latency 300-600ms → results arrive 2-5 words late. Wider `windowEnd` and larger drift accommodate this.
- Fast singers anticipate beats → `-0.5s` early buffer.
- Slow lines: tighter drift (14) reduces cross-line matching risk.

**Implementation:** `getWindowParams(tempoClass)` helper returns constants. Called once per `setActiveLine()`, stored on GameMode. All matching functions read from stored values.

### 3. Soft Line Boundaries

Replace the hard fence reset with an overlap zone where both the old and new line match simultaneously.

**Current (hard boundary):**
1. Line change detected → `setActiveLine()` called
2. Old line state snapshotted, fence reset, matchedSet cleared
3. 800ms later, `_lateScoreLine()` tries -4 lookback
4. ASR results after 800ms are lost

**Proposed (soft boundary):**

```
LINE N active          OVERLAP ZONE           LINE N+1 active
─────────────────┤ ← lineN+1.time → ├──────────────────────
                  │                   │
  matching lineN  │  matching BOTH    │  matching lineN+1
  scoring lineN   │  scoring both     │  scoring lineN+1
                  │                   │
                  │← overlapDuration →│
```

**Overlap duration by tempo:**

| tempoClass | Overlap |
|------------|---------|
| `slow`     | 1.0s    |
| `normal`   | 0.8s    |
| `fast`     | 0.5s    |

**Mechanics:**
1. On line change, old line's `matchedSet`, `lineWords`, and fence are preserved in a `prevLine` overlay (not destroyed).
2. Incoming ASR results match against both old line (unmatched words) and new line.
3. Each lyric word belongs to exactly one line — no competition or theft.
4. Old line checked first (overdue words), then new line.
5. After `overlapDuration`, old line is finalized and overlay discarded.

**What this fixes:**
- ASR finals arriving 200-800ms after line change still credit the correct line.
- Fast transitions get shorter overlap (0.5s) so they don't pile up.
- Eliminates the need for the -4 lookback hack.

### 4. Dynamic Late Scoring

Replace fixed 800ms `_lateScoreLine()` with tempo-aware timing anchored to the overlap zone.

**Score delay by tempo (measured from end of overlap zone):**

| tempoClass | Score delay | Total from line change |
|------------|-------------|------------------------|
| `slow`     | 1.2s        | 2.2s                   |
| `normal`   | 0.8s        | 1.6s                   |
| `fast`     | 0.5s        | 1.0s                   |

**Simplifications enabled by soft boundaries:**
- No -4 word lookback needed — overlap already captured late matches.
- No snapshot-and-freeze — scoring reads final state of the `prevLine` overlay.

**Fallback:** If the score timer fires while the next overlap is already active (extremely fast succession), score from whatever matches exist at that moment.

### 5. Dynamic Whisper Chunks

Reduce AudioWorklet chunk size for fast sections so Whisper results arrive sooner.

| tempoClass | Chunk size | Samples (16kHz) | Expected Whisper latency |
|------------|-----------|-----------------|--------------------------|
| `slow`     | 2.0s      | 32000           | ~2.5-3s                  |
| `normal`   | 1.5s      | 24000           | ~2-2.5s                  |
| `fast`     | 0.75s     | 12000           | ~1-1.5s                  |

**How tempo reaches the AudioWorklet:**
- `setActiveLine()` posts a message: `port.postMessage({ type: 'setChunkSize', samples: N })`
- AudioWorklet updates `chunkTarget` on the fly — no restart needed.

**Backend:** `faster-whisper` with `large-v3-turbo` on GPU handles 0.75s audio in ~100-200ms. At 0.75s intervals, request rate is ~1.3/s — trivial for local Flask.

## Files Affected

| File | Changes |
|------|---------|
| `static/player.js` | Tempo analysis, adaptive windows, soft boundaries, dynamic scoring |
| `static/audio-processor.js` | Dynamic chunk target via message handler |
| `app.py` | None expected (Whisper endpoint already handles variable-length audio) |

## Non-Goals

- No changes to phonetic matching, contraction expansion, or edit distance logic.
- No changes to the Web Speech API recognition setup (continuous mode, alternatives, etc.).
- No changes to the debug HUD layout (though it should display tempoClass and overlap state).
