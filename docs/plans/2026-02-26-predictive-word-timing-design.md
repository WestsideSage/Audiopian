# Predictive Word Timing Design

## Problem

Words turn green too late during gameplay. The current system is purely reactive:
sing -> mic capture -> speech recognition (300ms+ interim, 2s Whisper) -> match -> green.
There is no prediction of when words should be sung, so the system waits for full
recognition confidence before marking a word as matched.

## Goal

Reduce green-turn-on latency by 200-500ms using LRC timestamp data to predict when
each word should be sung, enabling the system to accept matches more eagerly when
timing aligns with predictions.

User preference: responsiveness over accuracy. False positives are acceptable and
can be tuned after implementation.

## Approach: Predictive Word Windows + Audio Energy Gating

### 1. Word-Level Timestamp Interpolation

At song load time, compute an estimated timestamp for every word in every line.

**Input:** LRC lines with `{time, text}` pairs (line-level timestamps only).

**Algorithm:**
- Line duration = nextLine.time - thisLine.time (last line: 4s default)
- Estimate syllable count per word using vowel-cluster heuristic
- Distribute line duration across words weighted by syllable count
- Each word gets: `{text, estimatedTime, windowStart, windowEnd}`
- `windowStart` = estimatedTime - 300ms (allow singing slightly early)
- `windowEnd` = estimatedTime + 1500ms (generous late buffer for recognition lag)

**Example:** Line at 10.0s ("don't stop believing"), next line at 14.0s (4s duration):
- "don't" (1 syl): ~10.0s
- "stop" (1 syl): ~10.8s
- "believing" (3 syl): ~11.6s

Computed once, stored on the lyrics data structure.

### 2. Predictive Pre-Arming & Instant Green

**Active word tracking:** A `hotWordIndex` tracks which word's time window contains
the current audio time, updated in the existing 100ms poll loop.

**Prioritized matching for hot words:** When a recognition result fires:
1. Check if spoken words match the currently-hot word (same fuzzy/phonetic logic).
   If yes, turn green immediately.
2. Run the existing full-line drift-window scan for remaining words.

**Interim-boosted matching for hot words:** Interim results (fast but unreliable)
get a lower acceptance bar for hot words. If an interim contains a phonetic match
for the expected word at this moment, accept it. The timing prediction provides
high prior confidence.

**Fallback:** The existing drift-window matching remains as-is. If prediction is
wrong (user skips a word, LRC timing is off), the current system still catches
everything. The prediction layer is purely additive.

**Tunable parameter:** Interim match confidence threshold for hot words. Start
aggressive, dial back if false positives are problematic.

### 3. Audio Energy Gating

**Purpose:** Prevent false greens during silence (e.g., user pauses between words
but LRC prediction says a word should happen now).

**Implementation:**
- Extend existing AudioWorklet (`audio-processor.js`) with lightweight RMS energy
  calculation, posted alongside audio chunks.
- Main thread maintains a rolling `isSpeaking` boolean (energy above threshold).
- Hot-word matching behavior:
  - `isSpeaking` true + partial interim match -> accept (instant green)
  - `isSpeaking` false + partial interim match -> require full match confidence
- ~10 lines in AudioWorklet, ~5 lines in GameMode to consume energy signal.

### 4. Update Loop Integration

No new timers or intervals. Everything uses existing infrastructure:

```
Song load -> interpolate word timestamps (one-time computation)
100ms poll (updateLyrics) -> also update hotWordIndex from audio.currentTime
Recognition fires -> check hot word first (instant green) -> then full-line scan
AudioWorklet -> post energy level -> update isSpeaking flag
```

**Data structures added to GameMode:**
- `wordTimings[]` - interpolated timestamps for current line's words
- `hotWordIndex` - index of word whose window contains current audio time
- `isSpeaking` - boolean from energy gating

## Files Modified

| File | Changes |
|------|---------|
| `static/player.js` | Word interpolation, hot-word tracking, modified matching, energy consumption |
| `static/audio-processor.js` | RMS energy calculation posted with chunks |

## Risk Mitigation

- Interpolation is imprecise for unevenly-paced lines (rap, spoken word). The
  existing drift-window matching handles these cases as it does today.
- Energy gating threshold may need per-environment tuning (mic sensitivity varies).
  A reasonable default with optional config is sufficient.
- Sticky matching semantics are preserved: once green, stays green. Prediction
  cannot make a word un-green.
