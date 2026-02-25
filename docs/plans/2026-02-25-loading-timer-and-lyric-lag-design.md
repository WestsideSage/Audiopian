# Loading Timer & Lyric Lag Fix Design

**Date:** 2026-02-25
**Context:** Two follow-up improvements after initial karaokee-improvements ship.

---

## Feature 1: Elapsed Time on Loading Overlay

**Goal:** Show how long vocal separation has been running so users know the app is still working.

**Why elapsed time, not a fake progress bar:** Demucs exposes no progress signal — it is a subprocess that runs and exits. A fake percentage would give false accuracy. Elapsed time is honest and equally reassuring.

**Architecture:** Frontend-only. No backend changes.

**Components:**
- `static/player.html`: Add `id="prepStatus"` to the existing status `<span>`.
- `static/player.js`:
  - Module-level `prepTimer` variable (stores `setInterval` handle, initialized `null`).
  - `initPrepOverlay()` starts a 1-second interval that computes `m:ss` elapsed and sets `prepStatus.textContent`.
  - `finishPrep()` and `skipPrep()` both call `clearInterval(prepTimer)`.

**Display format:** `Preparing audio… (1:23)` — the elapsed portion appended in parentheses.

---

## Fix 2: Lyric Matching Lag on Fast Songs

**Root cause:** `lineStartWordCount` in `GameMode.setActiveLine()` is computed from `this.transcript` (committed final text only). For fast rap, Chrome's speech recognition can go 3–5 seconds without producing a final result — the entire recognition output stays as a growing interim. During that window, every new line starts with `lineStartWordCount = 0`, so `_collectMatches` searches from position 0 against a transcript that grows to span many lines, running into the same drift-window miss that we partially fixed earlier.

**Fix:** Cache the latest interim text in `GameMode.latestInterim`. In `setActiveLine()`, compute `lineStartWordCount` from `normalizeWords(this.transcript + this.latestInterim).length` instead of `this.transcript` alone. The `onresult` handler updates `latestInterim` each time it fires.

**Components:** `static/player.js` only.

**Testing:** Manual — rap a fast song in game mode, expect noticeably higher match rate on rapid-fire bars. Backend tests unaffected.
