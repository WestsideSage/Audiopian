# Consolidated Plan Record

This file merges the original design and implementation documents for this feature.

## Design

# Loading Timer & Lyric Lag Fix Design

**Date:** 2026-02-25
**Context:** Two follow-up improvements after initial karaokee-improvements ship.

---

## Feature 1: Elapsed Time on Loading Overlay

**Goal:** Show how long vocal separation has been running so users know the app is still working.

**Why elapsed time, not a fake progress bar:** Demucs exposes no progress signal â€” it is a subprocess that runs and exits. A fake percentage would give false accuracy. Elapsed time is honest and equally reassuring.

**Architecture:** Frontend-only. No backend changes.

**Components:**
- `static/player.html`: Add `id="prepStatus"` to the existing status `<span>`.
- `static/player.js`:
  - Module-level `prepTimer` variable (stores `setInterval` handle, initialized `null`).
  - `initPrepOverlay()` starts a 1-second interval that computes `m:ss` elapsed and sets `prepStatus.textContent`.
  - `finishPrep()` and `skipPrep()` both call `clearInterval(prepTimer)`.

**Display format:** `Preparing audioâ€¦ (1:23)` â€” the elapsed portion appended in parentheses.

---

## Fix 2: Lyric Matching Lag on Fast Songs

**Root cause:** `lineStartWordCount` in `GameMode.setActiveLine()` is computed from `this.transcript` (committed final text only). For fast rap, Chrome's speech recognition can go 3â€“5 seconds without producing a final result â€” the entire recognition output stays as a growing interim. During that window, every new line starts with `lineStartWordCount = 0`, so `_collectMatches` searches from position 0 against a transcript that grows to span many lines, running into the same drift-window miss that we partially fixed earlier.

**Fix:** Cache the latest interim text in `GameMode.latestInterim`. In `setActiveLine()`, compute `lineStartWordCount` from `normalizeWords(this.transcript + this.latestInterim).length` instead of `this.transcript` alone. The `onresult` handler updates `latestInterim` each time it fires.

**Components:** `static/player.js` only.

**Testing:** Manual â€” rap a fast song in game mode, expect noticeably higher match rate on rapid-fire bars. Backend tests unaffected.

---

## Implementation

# Loading Timer & Lyric Lag Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an elapsed-time counter to the loading overlay and fix word-matching lag on fast rap songs by anchoring `lineStartWordCount` to the interim transcript as well as committed finals.

**Architecture:** Both changes are frontend-only (`player.html` and `player.js`). No backend changes, no new files. The timer uses a module-level `setInterval` cleared on dismiss. The lag fix adds a `latestInterim` field to `GameMode` that is updated each `onresult` event and read in `setActiveLine`.

**Tech Stack:** Vanilla JS, plain HTML. No test framework for frontend â€” verification is manual browser testing. Backend test suite (`pytest`) must stay green.

> âš ï¸ **Windows template literal warning:** When editing `player.js`, ALWAYS use the `Edit` or `Write` tools directly from the main Claude context. Do NOT delegate JS file writes to Bash subagents â€” backtick template literals get silently stripped on Windows.

---

### Task 1: Add elapsed-time counter to the loading overlay

**Files:**
- Modify: `static/player.html`
- Modify: `static/player.js`

**Step 1: Add `id="prepStatus"` to the status span in player.html**

In `static/player.html`, find:
```html
            <div class="prep-status">
                <div class="prep-spinner"></div>
                <span>Preparing audioâ€¦</span>
            </div>
```
Replace with:
```html
            <div class="prep-status">
                <div class="prep-spinner"></div>
                <span id="prepStatus">Preparing audioâ€¦</span>
            </div>
```

**Step 2: Add `prepTimer` module-level variable to player.js**

Near the top of `player.js`, after the `let overlayDismissed = false;` line, add:

```javascript
let prepTimer = null;
```

**Step 3: Update `initPrepOverlay` to start the timer**

Find the existing `initPrepOverlay` function:
```javascript
function initPrepOverlay() {
    var sd = JSON.parse(sessionStorage.getItem('songData') || 'null');
    if (sd) {
        document.getElementById('prepSongTitle').textContent =
            sd.artist + ' \u2014 ' + sd.title;
    }
    pollPrep();
}
```

Replace with:
```javascript
function initPrepOverlay() {
    var sd = JSON.parse(sessionStorage.getItem('songData') || 'null');
    if (sd) {
        document.getElementById('prepSongTitle').textContent =
            sd.artist + ' \u2014 ' + sd.title;
    }
    var startTime = Date.now();
    prepTimer = setInterval(function() {
        var elapsed = Math.floor((Date.now() - startTime) / 1000);
        var m = Math.floor(elapsed / 60);
        var s = (elapsed % 60).toString().padStart(2, '0');
        var el = document.getElementById('prepStatus');
        if (el) el.textContent = 'Preparing audio\u2026 (' + m + ':' + s + ')';
    }, 1000);
    pollPrep();
}
```

**Step 4: Clear the timer in `finishPrep` and `skipPrep`**

Find `finishPrep`:
```javascript
function finishPrep(success) {
    if (success) {
        instrumentalReady = true;
    }
    overlayDismissed = true;
```
Add `clearInterval(prepTimer);` as the first line of the function body:
```javascript
function finishPrep(success) {
    clearInterval(prepTimer);
    if (success) {
        instrumentalReady = true;
    }
    overlayDismissed = true;
```

Find `skipPrep`:
```javascript
function skipPrep() {
    overlayDismissed = true;
```
Add `clearInterval(prepTimer);` as the first line:
```javascript
function skipPrep() {
    clearInterval(prepTimer);
    overlayDismissed = true;
```

**Step 5: Manual verification**

Start the Flask server, load a song, open the player page. Confirm:
- The overlay shows "Preparing audioâ€¦ (0:01)", "(0:02)" etc., incrementing each second
- When separation completes (overlay fades), the timer stops
- Clicking Skip also stops the timer
- No JS errors in console

**Step 6: Run backend tests to confirm nothing broke**

```bash
cd C:/GPT5-Projects/Karaokee && python -m pytest tests/ -v
```
Expected: all 27 tests PASS.

**Step 7: Commit**

```bash
git add static/player.html static/player.js
git commit -m "feat: add elapsed-time counter to loading overlay"
```

---

### Task 2: Fix lyric matching lag on fast songs (latestInterim anchor)

**Files:**
- Modify: `static/player.js`

**Background:** `lineStartWordCount` is computed from `this.transcript` (committed finals only). For fast rap, Chrome may not produce a final for 3â€“5 seconds. During that window every line starts with `lineStartWordCount = 0`, so `_collectMatches` searches from position 0 and the drift window misses current-line words. Fix: also include the latest interim text in the word-count anchor.

**Step 1: Add `latestInterim` field to constructor and `start()`**

In the `GameMode` constructor, find:
```javascript
        this.transcript        = '';      // accumulated final transcript (never reset)
        this.lineStartWordCount = 0;      // word count in transcript when current line started
```
Add one line after:
```javascript
        this.transcript        = '';      // accumulated final transcript (never reset)
        this.lineStartWordCount = 0;      // word count in transcript when current line started
        this.latestInterim     = '';      // most recent interim, used to anchor fast-song lines
```

In `start()`, find `this.transcript = '';` and add the new field reset beneath it:
```javascript
        this.transcript = '';
        this.lineStartWordCount = 0;
        this.latestInterim = '';
```

**Step 2: Cache `latestInterim` in `onresult`**

In the `onresult` handler, find the line:
```javascript
            if (finalText) self.transcript += finalText;
```
Add one line after to cache the current interim:
```javascript
            if (finalText) self.transcript += finalText;
            self.latestInterim = interim;
```

**Step 3: Use `transcript + latestInterim` for `lineStartWordCount` in `setActiveLine`**

Find:
```javascript
        this.lineStartWordCount = normalizeWords(this.transcript).length;
```
Replace with:
```javascript
        this.lineStartWordCount = normalizeWords(this.transcript + this.latestInterim).length;
```

**Step 4: Manual verification**

Load a fast rap song in Game mode. Rap along for a verse. Expect:
- Noticeably more words highlighting green on fast bars compared to before
- Slow/clear lines still highlight correctly
- No JS errors in console

**Step 5: Run backend tests**

```bash
cd C:/GPT5-Projects/Karaokee && python -m pytest tests/ -v
```
Expected: all 27 tests PASS.

**Step 6: Commit**

```bash
git add static/player.js
git commit -m "fix: anchor lineStartWordCount to interim transcript for fast-rap accuracy"
```
