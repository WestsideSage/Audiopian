# VAD-Gated Optimistic Scoring — Design Document

**Date:** 2026-03-17
**Status:** Approved

## Problem Statement

The current lyrics matching system uses ASR (Whisper + Web Speech API) as the primary gating mechanism: a word only turns green after ASR transcribes it and the match passes validation. This architecture has an inherent latency floor — Whisper processes audio in chunks with 500–1500ms turnaround, and Web Speech API batches fast speech into bursts. For slow songs this is fine. For fast sections (rapid verses, rap), ASR cannot keep up and entire verses go unscored despite being sung correctly.

Additionally, false greens are occurring on ad-libs and background vocals from the track being picked up through the mic — likely because `echoCancellation` is not enabled on the `getUserMedia` call.

The root issue is that the current model is **confirmation-first**: ASR must confirm before the word lights up. The desired experience is a **game-feel model**: words light up as you say them, in real time.

## Goals

- Words light up immediately when sung — no waiting for ASR
- Works at any song speed, including Eminem-tier fast rap
- Per-song tempo calibration (not global fixed thresholds)
- Fix existing audio bleed / false green issue
- No backend changes, no new dependencies
- Slow songs continue to use the existing ASR path unchanged

## Design

### 1. Echo Cancellation Fix (applies to current system too)

Update the `getUserMedia` call to enable browser AEC:

```js
getUserMedia({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
})
```

This removes audio playing through headphones/speakers from the mic signal at the source, eliminating ad-lib false greens in both the current ASR path and the new VAD path.

### 2. Voice Activity Detection (VAD)

A lightweight VAD is added using the Web Audio API. An `AnalyserNode` is connected to the mic stream and polled every ~20ms. RMS energy is computed over the frequency range 100–3000 Hz (human vocal range) to avoid reacting to low-frequency rumble or high-frequency hiss.

```
Mic → MediaStreamSource → AnalyserNode → RMS computation (20ms interval)
                                              ↓
                                       isVoiceActive (boolean)
```

**Ambient baseline:** During the first 2 seconds of song playback (before the user typically starts singing), the VAD samples the ambient noise floor. The voice threshold is set as `baseline + offset` rather than a fixed value. This handles mic sensitivity differences between users and catches any residual bleed not removed by AEC.

### 3. Per-Song Tempo Calibration

At song load time, after word timings are interpolated, compute the song's tempo distribution across all lines:

1. For each line, compute `wordsPerSecond = wordCount / lineDuration`
2. Collect all per-line WPS values
3. Compute the 50th and 80th percentiles of that distribution

These percentiles define the slow/medium/fast boundaries **relative to this song**. A Kendrick Lamar track with a wide tempo range self-calibrates correctly — slow bars use the existing ASR path, fast bars use VAD-gated scoring.

| Tempo class | Threshold | Primary scorer |
|---|---|---|
| slow | Below song's 50th percentile WPS | Existing ASR matching (unchanged) |
| medium | 50th–80th percentile WPS | VAD-gated optimistic |
| fast | Above 80th percentile WPS | VAD-gated optimistic |

The computed thresholds are shown in the debug HUD at song start.

### 4. Optimistic Scoring Path

For lines classified as `medium` or `fast`, the scoring model flips:

**Current model (ASR-first):**
```
ASR transcribes word → match validated → word turns green
```

**New model (VAD-gated optimistic):**
```
Word's time window arrives AND VAD detects voice → word turns green immediately
```

Specifically, for each word in a VAD-mode line:
- When playback enters the word's `windowStart`, begin watching VAD
- If `isVoiceActive` is true at any point before `windowEnd`, mark word as hit → green
- If `windowEnd` passes with no voice detected, mark as miss → red

The existing word time windows (already computed by the interpolation system) are reused unchanged.

### 5. ASR Confirmation Layer

The existing ASR pipeline (Whisper + Web Speech API) continues running unchanged in the background. When ASR produces a match for a word that is already VAD-greened:

- The word receives a **visual upgrade** — a brighter flash or sparkle animation
- This signals "you said the right word" vs. "you were making sounds"
- No score effect — confirmation is cosmetic only

If ASR doesn't confirm (too slow, fast section, word not transcribed), the word stays regular green and the score is unaffected. No penalties.

### 6. Score Calculation

Score formula is unchanged: `score = hits / totalWords`

A "hit" in VAD mode = voice detected during the word's time window.
A "hit" in ASR mode (slow lines) = existing match logic.

Lines mix modes freely within a song — each line independently uses whichever path its tempo class dictates.

## Updated Processing Pipeline

```
Song Load
  └─ computeSongTempoProfile()     ← NEW: percentile thresholds
  └─ getUserMedia (echoCancellation: true)  ← UPDATED
  └─ initVAD()                     ← NEW: AnalyserNode + polling loop

Playback
  For each word:
    if line.tempoClass == 'slow'
      └─ existing ASR matching path (unchanged)
    else
      └─ VAD window watch:
           windowStart → poll isVoiceActive → hit/miss at windowEnd
           ASR background → confirm → visual upgrade if hit
```

## Files Modified

| File | Changes |
|---|---|
| `static/player.js` | `initVAD()`, `computeSongTempoProfile()`, VAD scoring path in word evaluation loop, ASR confirmation visual upgrade, updated `getUserMedia` constraints |
| `static/sync-helpers.js` | Replace fixed WPS thresholds with `classifyLineTempoRelative(wps, profile)` using per-song percentiles |
| `static/audio-processor.js` | VAD energy computation helper (RMS over vocal frequency band), or inline in player.js if small enough |

No backend changes. No new npm/pip dependencies.

## Debug HUD Additions

- Song tempo profile at load: `p50: 2.1 WPS | p80: 3.8 WPS`
- Per-line tempo class indicator (already exists, updated to show song-relative classification)
- Current VAD state: `VAD: active / silent`
- Ambient baseline value
- ASR confirmation count per line (e.g., `confirmed: 4/8`)

## What Stays the Same

- Existing ASR matching for slow lines
- Word time window computation (interpolation system)
- Scoring formula
- All existing debug HUD elements
- Whisper backend architecture
- Contraction expansion, canonicalization, phonetic matching (still used for slow lines and ASR confirmation)
