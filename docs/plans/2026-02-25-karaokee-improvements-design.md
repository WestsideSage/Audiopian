# Karaokee Improvements Design

**Date:** 2026-02-25
**Context:** Post-launch improvements based on testing with rap/hip-hop music.

---

## Area 1: Word Matching Overhaul

### Problem

Three compounding issues reduce word detection to ~30–50% for rap:

1. **Contraction expansion bug** — `setActiveLine()` calls `expandContractions([nw]).join(' ')`, producing a single multi-word string (e.g. `"gonna"` → `"going to"` as one string). In `_matchTranscript`, spoken words are individual tokens, so `"going"` never equals `"going to"`. Spans go unlit.

2. **Drift window too tight** — window of 3 is too small for fast rap bars where words arrive in rapid bursts.

3. **Single-alternative transcript** — Chrome's first alternative for slang often misses; alternatives 2–3 frequently get it right.

### Solution

**Fix 1 — Remove contraction expansion from `lineWords`.**
`lineWords[i]` = `normalizeWord(w)` only (lowercase + strip punctuation). This keeps `lineWords` 1:1 with spans, fixing the type mismatch entirely.

**Fix 2 — Drop contraction expansion from both sides during matching.**
For rap, Chrome Speech API transcribes words phonetically as spoken ("gonna" → "gonna"), so the expansion map hurts more than it helps. Both sides use plain `normalizeWords()`.

**Fix 3 — Widen drift window: 3 → 6.**
Accommodates fast rap cadence where multiple words can arrive between polling cycles.

**Fix 4 — `maxAlternatives: 3`.**
Set on the `SpeechRecognition` instance. In `onresult`, collect all final alternatives per result and run `_matchTranscript` against each, taking the union of matched indices across all alternatives.

### Files Changed
- `static/player.js` — `setActiveLine()`, `_matchTranscript()`, `_setupRecognition()`

---

## Area 2: Pre-processing Loading Screen

### Problem

Vocal separation is manually triggered and takes 2–3 minutes. Users must wait after clicking "Remove Vocals" or "Game", interrupting the flow.

### Solution

**Backend — auto-kick separation on `/load`.**
After `download_audio()` completes in the `/load` endpoint, immediately start `separate()` in a background thread (same pattern as the existing `/separate` route). The `/separate` endpoint remains but becomes a no-op if separation is already running or done.

**Frontend — loading overlay on player page.**
`player.html` renders a full-screen overlay on load. The overlay displays the song title/artist and a pulsing "Preparing audio…" message. It polls `/separate-status` every 2 seconds. On `done`, the overlay fades out and the song autoplays — both Remove Vocals and Game mode are immediately available with no further wait.

**Skip button.**
The overlay includes a "▶ Skip (karaoke only)" button. Clicking it dismisses the overlay immediately, autoplays the full mix, and marks `instrumentalReady = false`. The Game button remains visible but shows a tooltip "Still processing…" and blocks activation until separation completes (checked on click).

### Files Changed
- `app.py` — `/load` endpoint auto-kicks separation
- `static/player.html` — loading overlay HTML + CSS
- `static/player.js` — overlay poll loop, skip logic, game button guard

---

## Area 3: Demucs Quality Upgrade

### Problem

Current model `htdemucs` leaves audible vocal bleed-through in the instrumental track, which causes the Speech API microphone to pick up residual vocals and produce incorrect transcripts.

### Solution

Switch to `htdemucs_ft` (fine-tuned variant). It was trained with additional data specifically to reduce vocal bleed and produces noticeably cleaner separation. Processing time increases ~50%, which is acceptable given the loading screen in Area 2 absorbs the wait.

**Change required:**
- `--name htdemucs` → `--name htdemucs_ft`
- Output glob pattern: `htdemucs/` → `htdemucs_ft/`

### Files Changed
- `vocal_remover.py`

---

## Out of Scope

- Phonetic / fuzzy word matching (Soundex, edit distance) — deferred to v3
- Score persistence / leaderboard
- Mobile support
