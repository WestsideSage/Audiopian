# 2026-04-20 — Full Repository Autopsy

Prepared by: Opus (adversarial audit)
Scope: entire repository as of `main` @ `836cb2d` plus uncommitted working tree

---

## 1. Executive Summary

Karaokee is structurally **drifting toward collapse**, not failing outright. The backend (`app.py`, `downloader.py`, `lyrics.py`) is small, coherent, and reasonably tested. The frontend is the opposite: a single 2,434-line [static/player.js](static/player.js) with ~37 methods on one `GameMode` class, poorly isolated DOM coupling, under-tested scoring logic, and — right now — an uncommitted rollout that the project's own [2026-04-20 retrospective](docs/retrospectives/2026-04-20-scoring-regression-retrospective.md) explicitly says should be reverted. On top of that the repo carries a large amount of dead weight: an orphaned React/TypeScript `src/` tree, an empty `package.json`-era build stub, 33 MB of stale `demucs_out` artifacts, two empty `.worktrees` stubs, and 39 overlapping planning docs.

Main risks, in order: (a) **core scoring logic is gameable and arithmetically inconsistent** — VAD can score pure mic-noise, repeated-target words produce phantom credit, and the late-upgrade path silently double-adjusts weights; (b) **the current working tree is a known-bad rollout** and should be reverted before more work lands; (c) **test coverage hides all of this** — the main IP (the JS scoring pipeline, lrclib ranking) has zero direct tests, while `test_telemetry.cjs` asserts against stubs defined in the same file; (d) **documentation drift** already misrepresents runtime defaults (e.g. `WHISPER_DEVICE=cuda` in [README.md:63](README.md:63) vs. actual `cpu` in [app.py:14](app.py:14)).

Verdict: **significant cleanup required**, but the bones are salvageable. Two weeks of disciplined work on the priorities in §9 would put this project on solid ground. Another month of additive feature work on the current foundation would not.

---

## 2. Repo Health Scorecard

| Dimension | Score | Justification |
|---|---|---|
| Architecture | **4/10** | Backend clean, 4-file module boundaries intact. Frontend collapses to one 2,434-line god-file ([static/player.js](static/player.js)) with one god-class (`GameMode`, 37 methods). Orphan `src/` React tree further muddies the runtime picture. |
| Code clarity | **5/10** | Backend is readable. Helpers (`match-helpers.js`, `sync-helpers.js`) are clean and testable. `player.js` is understandable in short windows but its aggregate flow (ASR → VAD provisional → late upgrade → prev-line overlap → late rescue → end-of-song rescoring) is not documented and requires reasoning across hundreds of lines. |
| Correctness confidence | **3/10** | Multiple proven correctness bugs in the scoring path (§3, §5). The current uncommitted diff is a documented-broken rollout. |
| Performance | **6/10** | No critical hot-path explosions, but 100 ms `updateLyrics` interval does `querySelectorAll` + DOM mutation every tick; `whisperBuffer` grows unboundedly; `normalizeWords(transcript)` is recomputed on every `onresult` / whisper chunk / hot-word match. Not urgent, but wasteful. |
| Maintainability | **4/10** | No way to change scoring behavior with confidence — no unit coverage of the core algorithms, no abstraction layer between DOM and scoring. Adding a bugfix is scary; adding a feature is scarier. |
| Testability | **4/10** | Backend: good unit boundaries. Frontend: the core scoring loop is inlined into DOM-coupled methods; not Node-testable. The pure helpers that *are* Node-testable are exactly the parts least likely to break. |
| Documentation | **5/10** | Tons of documentation (39 plan files, retrospectives, audit, two agent guides). But heavily duplicated, stale in places (CUDA defaults), and the sheer volume hides the signal. No high-level architecture doc; README is shipped-state-drift. |
| Cleanup urgency | **9/10** | Orphan `src/`, 33 MB demucs artifacts, stale temp files, known-broken uncommitted diff, dead code paths — all blocking a clean pickup of this codebase. |

---

## 3. High-Risk Findings

### F-1. Current uncommitted working tree is a known-broken rollout
- **Severity:** Critical
- **Confidence:** High
- **Why it matters:** The project's own retrospective ([docs/retrospectives/2026-04-20-scoring-regression-retrospective.md:13](docs/retrospectives/2026-04-20-scoring-regression-retrospective.md:13)) explicitly states: *"the last `player.js` refactor should be treated as a failed rollout and should not be tuned forward in place"*. Yet `git status` shows modified `app.py`, `player.js`, `match-helpers.js`, `sync-helpers.js`, `audio-processor.js`, `player.html`, and three test files, uncommitted. A new contributor (or a future Claude session) will assume this is the current intended state and build on it.
- **Evidence:** `git status` shows ` M static/player.js` etc. The retrospective references the same files.
- **Recommended fix:** Decide now: either revert to `836cb2d` and cherry-pick the "safe salvage" items the retrospective lists (continuous tempo helpers, comparable-word policy, SR counters, energy summarization, CUDA→CPU fallback), or commit the current state to a clearly-named branch so `main` stops carrying it. Do not leave it floating.

### F-2. Repeated-target-word false credit in both match loops
- **Severity:** High
- **Confidence:** High (proven by code reading)
- **Why it matters:** When a line contains consecutive identical targets (e.g. `"la la la"`, `"no no no"`, chorus repeats like `"read your mind, read your mind"`), a single spoken token can credit every repeated slot.
- **Evidence:** [static/player.js:1371-1375](static/player.js:1371) in `_collectMatches`:
    ```js
    var nextTarget = (li + 1 < this.lineWords.length) ? this.lineWords[li + 1] : null;
    if (nextTarget !== target) {
        spokenIdx = si + 1;
    }
    ```
  If `nextTarget === target`, `spokenIdx` is NOT advanced; the outer loop advances `li`; the inner loop restarts at the same `spokenIdx` and matches the same `spoken[si]` against `li+1`. Identical bug in `_collectMatchesWhisper` at [player.js:1005-1009](static/player.js:1005), and again in `_lateScoreLine` at [player.js:1756-1760](static/player.js:1756).
- **Recommended fix:** Advance `spokenIdx` unconditionally when a match is recorded, but allow the inner loop to scan *past* `spokenIdx` for the `nextTarget === target` case — i.e. keep spoken monotonic, but relax the per-target search start window. Add a regression test: `lineWords = ["la","la","la"]`, spoken `["la"]` should credit exactly 1 slot, not 3.

### F-3. VAD "provisional" credit is gameable with any mic noise
- **Severity:** High
- **Confidence:** High
- **Why it matters:** The Codex 4-6 audit already flagged this. It is still true. Any ambient sound above `_vadBaseline + 0.025` — a cough, a finger tap, a fan spin-up — grants 0.25 × word weight to `weightedMatched` via the hot-word VAD path.
- **Evidence:** [static/player.js:1520-1532](static/player.js:1520):
    ```js
    if (newHot >= 0 && this.isSpeaking && this.wordTimings.useVad && !this._suspended) {
        if (!this.matchedSet.has(newHot)) {
            this.matchedSet.set(newHot, 0.25);
            this.vadMatchedSet.set(newHot, 0.25);
            this.lineHadAsrEvent = true;   // tripping this unlocks scoring for silent lines
            ...
    ```
  Then in `_scoreLine` at [player.js:1624-1629](static/player.js:1624), a VAD-only slot is "downgraded" to 0.25, but 0.25 × weight is still added to `weightedMatched`. At the final-score threshold of 70% a user who stays silent but has ~3× ambient noise spikes per line can still score "perfect" on adlib-heavy lines.
- **Recommended fix:** Decide product intent. Either (a) VAD-only should count as zero toward the final score and only be a visual hint, or (b) VAD should credit only a small fixed cap (e.g. max 10% of line) and never flip `lineHadAsrEvent`. The current 25% × weight silent baseline is not defensible.

### F-4. `_collectMatchesWhisper` executes against the *current* line for responses recorded during an earlier line
- **Severity:** High
- **Confidence:** High
- **Why it matters:** `fetch('/transcribe')` is awaited. By the time the response arrives, `setActiveLine` may have advanced. The handler then calls `this._collectMatchesWhisper(this.whisperBuffer)` which matches against `this.lineWords` (the *new* line). The `X-Lyric-Hint` header was set from the *old* line. This causes Whisper to transcribe under one hint and score under a different target set — silently cross-wiring the scoring ledger across line boundaries.
- **Evidence:** [static/player.js:846-881](static/player.js:846), especially:
    ```js
    if (this.activeLineIdx >= 0 && lyrics[this.activeLineIdx]) {
        headers['X-Lyric-Hint'] = lyrics[this.activeLineIdx].text;  // captured at send
    }
    const resp = await fetch('/transcribe', ...);
    ...
    this._collectMatchesWhisper(this.whisperBuffer);  // uses CURRENT lineWords
    this._lateUpgradeFromWhisper(data.transcript);    // uses recentlyScored snapshot
    ```
- **Recommended fix:** Capture the `activeLineIdx` at send time; on response, either (a) route the transcript to the prev-line overlay (via `_matchPrevLine`) if the captured idx differs from the current, or (b) only run `_lateUpgradeFromWhisper` when the line has advanced, skipping `_collectMatchesWhisper`.

### F-5. `onSeek` resets less state than `setActiveLine`
- **Severity:** High
- **Confidence:** High
- **Why it matters:** When the user seeks inside the same line, `updateLyrics` early-returns at [player.js:2251](static/player.js:2251) (`idx === currentLineIndex`) and `setActiveLine` never runs. `gameMode.onSeek` clears `matchedSet`, `vadMatchedSet`, `asrConfirmedSet`, `hotWordIndex`, `whisperBuffer`, `prevLine` — but leaves stale:
    - `_lineEnergySamples` → silences/peaks from the pre-seek portion flow into `energySummary` of the next `_scoreLine` call
    - `_lineStartAudioTime` → `timeSpentMs` in telemetry is computed against the wrong baseline
    - `_telemetryLoggedMatches` → `activeLineIdx+':'+word` dedupe keys bleed; the same word on the same line after seek won't log again
    - `_lineComparisonCount`, `_searchWindowMax`, `_srBacklogMax`, `_srBacklogWidenings` → all carry pre-seek counts into post-seek telemetry
    - `lineHadAsrEvent` → if set pre-seek, the post-seek partial line scores as if ASR had fired
- **Evidence:** Compare [player.js:607-620](static/player.js:607) (`onSeek`) with [player.js:1229-1240](static/player.js:1229) (`setActiveLine`).
- **Recommended fix:** Factor a single `_resetLineState()` helper used by both `onSeek` and `setActiveLine`. Saves maintenance, fixes the drift.

### F-6. `_lateUpgradeFromWhisper` can double-count weight when initial score was partial
- **Severity:** High
- **Confidence:** Medium (requires specific timing to reproduce but the arithmetic is proven wrong on paper)
- **Why it matters:** The late-upgrade path at [player.js:1073-1088](static/player.js:1073) computes a delta by comparing to 0.25 (the VAD-downgrade value) *if* the slot was VAD-but-not-ASR-confirmed. But `_scoreLine` at [player.js:1624-1629](static/player.js:1624) only applied the 0.25 downgrade to `weightedMatched`; `matchedSet` itself still holds the pre-downgrade score (0.5, 0.75, 1.0). So the "existing effective" value in the late-upgrade path is reconstructed from two signals that can disagree. If `_scoreLine`'s downgrade rule ever changes, the late-upgrade delta silently diverges.
- **Evidence:** The rule is duplicated: [player.js:1624](static/player.js:1624) and [player.js:1074](static/player.js:1074).
- **Recommended fix:** Store the *post-downgrade* effective score in the snapshot, not the raw score — or better, do not duplicate the rule; expose `effectiveScore(slot, matchedSet, vadSet, asrSet)` as a pure helper and call it from both places.

### F-7. `whisperBuffer` is unbounded for the lifetime of the active line
- **Severity:** Medium
- **Confidence:** High
- **Why it matters:** Every Whisper chunk's transcript is concatenated into `this.whisperBuffer` at [player.js:877](static/player.js:877). The buffer is only cleared by `setActiveLine` and `onSeek`. For a long line (e.g. an intro held for 20s without advancing) the buffer grows without bound; each new chunk triggers a full `normalizeWords(this.whisperBuffer)` scan in `_collectMatchesWhisper`.
- **Evidence:** [player.js:877](static/player.js:877), [player.js:973](static/player.js:973).
- **Recommended fix:** Cap the buffer to the last N words (say 200) on append, or switch to per-chunk matching without concatenation.

### F-8. Unguarded `JSON.parse(sessionStorage…)` at module top-level
- **Severity:** Medium
- **Confidence:** High
- **Why it matters:** [player.js:2186](static/player.js:2186) does `const songData = JSON.parse(sessionStorage.getItem('songData') || 'null');` without try/catch. Any malformed `songData` entry (manually corrupted, partial write, different-origin collision) hard-crashes the page instead of redirecting to `/`.
- **Recommended fix:** Wrap in try/catch, treat parse error the same as missing.

### F-9. Replay after `ended` event may leak state
- **Severity:** Medium
- **Confidence:** Medium
- **Why it matters:** `replayGame` calls `gameMode.stop()` then `gameMode.start()`. `stop()` nulls the recognition object but does not reset counters like `_recentlyScored`, `_lineEnergySamples`, `_telemetryLoggedMatches`, `_lateUpgradeWordCount`, `_chunksDispatched`. The next game session starts with polluted accumulators. This is the same class of bug as the 4-6 Codex audit's item #7.
- **Evidence:** [player.js:558-578](static/player.js:558) (`stop`), [player.js:475-556](static/player.js:475) (`start`).
- **Recommended fix:** Add a single `_resetSessionCounters()` called from `start()`, listing every `this._foo = ...` accumulator currently initialised in `start()` plus the ones missed.

### F-10. Documentation drift on Whisper defaults
- **Severity:** Medium (low impact on runtime, high impact on contributor trust)
- **Confidence:** High
- **Evidence:** [README.md:63](README.md:63) says `WHISPER_DEVICE` default is `cuda` and `WHISPER_COMPUTE` default is `float16`. [app.py:14-16](app.py:14) actual defaults are `cpu` and `int8`. [CLAUDE.md:33](CLAUDE.md:33) correctly documents the real defaults. README further claims "NVIDIA GPU with CUDA support" is a prerequisite — demonstrably false; the retrospective notes CUDA is *broken* on this machine due to missing `cublas64_12.dll`.
- **Recommended fix:** Rewrite the "Environment Variables" and "Prerequisites" sections of README.md to match `app.py`, and add the missing `WHISPER_COMPUTE_CPU` row.

---

## 4. Dead Code / Stale Asset Report

### Safe to delete now (zero risk, zero runtime reference)
| Path | Why |
|---|---|
| `src/` (entire tree) | Abandoned React/TypeScript rewrite. `src/parser/parseLrc.ts`, `src/hooks/useLyricSync.ts`, `src/hooks/useGameEngine.ts`, `src/components/LyricsView.tsx` — no build config, not referenced by `app.py` / `static/` / `tests/`. [AGENTS.md:11](AGENTS.md:11) already says "Do not assume `src/` is production code." |
| `package.json` | Declares `vite`, `vitest`, `react`, `@types/react` — there is no `vite.config.*`, no `tsconfig.json`, no `index.html` Vite entry. `npm test` would run Vitest against zero tests. Remnant of the abandoned rewrite. |
| `demo.json` | Mock lyrics ("Demo Anthem" / "Karaokee Bot"). Not referenced anywhere in code. [2026-04-08 portfolio-readiness plan](docs/plans/2026-04-08-portfolio-readiness-implementation.md) already scheduled its deletion; still present. |
| `temp/write_tests.py` | A hardcoded-string script that writes `tests/test_lyrics.py`. Clearly a one-shot scaffolder committed by accident. |
| `temp/instrumental.wav` | 33 MB. Vocal-separation feature was removed; stale artifact. |
| `temp/demucs_out/` (including `htdemucs/`, `htdemucs_ft/`) | Demucs model weight caches. Feature deleted. |
| `.worktrees/telemetry-improvements/` | Empty directory. `git worktree list` shows no actual worktree here. |
| `.worktrees/whisper-fix/` | Only contains stale demucs weight directories. Not a live worktree. |
| `docs/plans/2026-03-03-slow-song-time-gate-design.md` | Design-only file with no corresponding `-implementation.md`. Approach was superseded by later "time-gated matching" and "algorithm-improvements" plans. |
| `GameMode._matchTranscript` ([player.js:1385-1390](static/player.js:1385)) | Defined; never called. `onresult` uses `_collectMatches` directly. |
| `.word-span.matched-partial` CSS rule ([player.html:127](static/player.html:127)) | Class defined; never added by JS (`_updateWordSpans` at [player.js:1402](static/player.js:1402) does add it, so **actually in use** — scratch this item). |

### Likely removable after validation
| Path | Why |
|---|---|
| `#no-lyrics` element ([player.html:374](static/player.html:374)) + `noLyricsEl` reference ([player.js:7](static/player.js:7)) | Element exists in HTML with `display:none`; [player.js:2201](static/player.js:2201) sets it visible only when `lyrics.length === 0`. Still used — scratch, keep. (Noted for audit; confirmed in use.) |
| `docs/plans/2026-02-19-karaokee-design.md` + `-implementation.md` | The v1 plan predates the v2 redesign in the same dated folder. v1 may no longer map to shipped state. Re-review and either merge into a historical summary or delete. |
| `docs/plans/2026-03-17-vad-analyser-lrc-offset.md` | No paired implementation file; likely a notes-only artifact. |
| `docs/plans/2026-03-17-vad-optimistic-scoring-design.md` + `-implementation.md` | Approach was walked back by [2026-04-06-slow-line-vad-scoring-honesty](docs/plans/2026-04-06-slow-line-vad-scoring-honesty.md). Keep as history or mark as superseded. |
| `tests/test_telemetry.cjs` | Tests stub objects defined in the same file. Zero production code touched. Either wire into CI with meaningful assertions or delete. |

### Keep, but relocate / consolidate
| Path | Why |
|---|---|
| `docs/retrospectives/2026-04-20-*.md` + `docs/session-learnings/2026-04-20-*.md` | 80% duplicate content about the same failed rollout. Merge into one. |
| `docs/plans/*-design.md` + `*-implementation.md` pairs (~19 pairs) | Merge each pair into a single doc per feature. Cuts plan count ~50%. |
| `AGENTS.md` | Strict subset of `CLAUDE.md`. Either add the env-var section + telemetry test and keep both, or make AGENTS.md a one-line pointer. |
| `docs/codex_audits/Codex-Audit-4-6-2026.txt` | Useful prior baseline. Rename to `.md` and put alongside new audits (this file). |

---

## 5. Algorithm / Logic Audit

### 5.1 Lyrics ranking (`lyrics.py`)
- **Intended:** Score candidate lrclib results by token overlap of title/artist plus duration proximity, prefer synced lyrics, return top.
- **Actual:** Matches intent. Code is simple and correct. `_token_overlap` is symmetric with `max` denominator — reasonable.
- **Risk:** No coverage — `_score_candidate` and `fetch_lyrics` have zero tests ([tests/test_lyrics.py](tests/test_lyrics.py) only tests `parse_lrc`). Any refactor can silently regress ranking.
- **Confidence:** High that it works today; low that it will keep working.
- **What to test:** (a) `_score_candidate` prefers higher title+artist overlap; (b) duration within 10s gets full credit; (c) a plain-lyrics candidate with perfect title match loses to a synced-lyrics candidate with slightly weaker title match when the difference is ~1.0 points.

### 5.2 Tempo classification + window selection (`sync-helpers.js`)
- **Intended:** Classify each line by words-per-second, derive timing windows for matching, drift allowances, chunk sizes.
- **Actual:** Matches intent. Has both discrete (`classifyTempo`) and continuous (`getContinuousTempoParams`) paths. Short-line overlap bonus at [sync-helpers.js:89-91](static/sync-helpers.js:89) is applied only on the continuous path, not the discrete path — minor asymmetry.
- **Risk:** Low. Well-tested by [test_sync_helpers.cjs](tests/test_sync_helpers.cjs).
- **Confidence:** High.

### 5.3 Word matching (`match-helpers.js` + `wordsMatchScore` in `player.js`)
- **Intended:** Multi-strategy matching — exact, suffix-normalized, contraction, slang, phonetic (Double Metaphone), edit-distance.
- **Actual:** Matches intent at the per-word level. Issue: the *phonetic* score is 0.8 regardless of how close the match is, and `edit1` is 0.75 — so an edit-distance-1 typo scores *lower* than an imperfect phonetic substitution, which feels backward.
- **Risk:** Phonetic acceptance guard (`sameFirst || bothLong` at [player.js:226-228](static/player.js:226)) is asymmetric — it allows short words with the same first letter but blocks long near-homophones that differ in the first letter ("psychology"/"cycology"). Minor.
- **Confidence:** Medium. No direct tests of `wordsMatchScore` — it lives in player.js, not match-helpers.js, so the Node tests do not cover it.
- **What to test:** Extract to a pure module; write a 30-case regression table of spoken/target pairs with expected method+score.

### 5.4 Line-level scoring (`_scoreLine`, `_lateScoreLine`, `_lateUpgradeFromWhisper`)
- **Intended:** Compute a weighted score per line; downgrade VAD-only slots; penalize missed words; flag "perfect" at 70% weighted threshold; allow late Whisper corrections.
- **Actual:** Matches intent but with the bugs in §3 (F-3, F-6). Specific additional concerns:
    - At [player.js:1675](static/player.js:1675) the per-line flash renders `+${matched}/${scorableTotal}` — if `scorableTotal === 0` (all-filler line) this is `+0/0` and `linesScored++` still fires, but `weightedTotal === 0` falls into the `else` branch at [player.js:1691](static/player.js:1691) and *breaks the streak*. A pure-filler line penalises the user.
    - `matchedWords/totalWords` ratio can drift above 1.0 if `_lateUpgradeFromWhisper` bumps `matchedWords` for a line where `_scoreLine` already counted it via `matchedSet.has(j)` (the increment at [player.js:1083-1086](static/player.js:1083) is guarded by `existingScore === 0`, so this is OK in the common path; it becomes wrong only if the snap is mutated between capture and upgrade — unlikely but not defended).
- **Risk:** High surface area, zero unit tests, multiple overlapping entry paths (`_scoreLine` called from `_finalizePrevLine`, `_lateScoreLine`, and (transitively) end-of-song).
- **Confidence:** Low.
- **What to test:** Extract the pure arithmetic of `_scoreLine` — input: `lineWords`, `wordTimings`, `matchedSet`, `vadMatchedSet`, `asrConfirmedSet`, `energySummary`. Output: `{weightedMatched, weightedTotal, matched, scorableTotal, perfect}`. Test 10-15 cases covering: all-matched, all-missed, all-filler, mixed VAD-only, instrumental-silent, ASR-confirmed upgrade of VAD, zero-ASR fencing.

### 5.5 State machine across line boundaries
- **Intended:** Each line has its own matching state; previous line gets a ~1s overlap window for late speech recognition to finish; final line gets an end-of-song late rescore.
- **Actual:** Works in the happy path. Fragility clusters:
    - `prevLine` overlay finalization is scheduled via `setTimeout` and also can be triggered by `ended` event and by the next `setActiveLine`. Three call paths, all race-guarded by `prevLine.lineIdx === capturedLineIdx` or `!this.prevLine`. The guards are correct but the *ordering* is not documented anywhere; any future edit risks double-scoring.
    - Seek-during-overlap clears `prevLine` ([player.js:618](static/player.js:618)) but the pending `setTimeout(_finalizePrevLine, …)` still fires and no-ops (checks `this.prevLine`). OK, but again no invariant doc.
- **Risk:** Medium — correct today, fragile to refactor.
- **Confidence:** Medium.

### 5.6 Whisper prewarm and fallback (`app.py`)
- **Intended:** Load the model lazily on first request; try CUDA then fall back to CPU; detect CUDA runtime errors mid-transcription and hot-reload on CPU.
- **Actual:** Implementation is careful — uses a lock, tri-state status, probe transcription. The `_is_cuda_runtime_error` needle list at [app.py:42-55](app.py:42) is string-matched against `str(exc).lower()` — brittle to libctranslate2 error-message changes but practical.
- **Risk:** Low.
- **Confidence:** High, within the tested paths.

---

## 6. Bug and Fragility Audit

Numbered for reference. Items already covered in §3 are referenced, not repeated.

1. Repeated-target false credit — F-2.
2. VAD free credit — F-3.
3. Stale-line Whisper scoring — F-4.
4. Partial state reset on seek — F-5.
5. Late-upgrade weight arithmetic — F-6.
6. Unbounded `whisperBuffer` — F-7.
7. Unguarded `JSON.parse(sessionStorage)` — F-8.
8. Replay leaks counters — F-9.
9. **Dead method `_matchTranscript`** ([player.js:1385](static/player.js:1385)) — would silently replace `matchedSet` with a union map instead of merging. If a future refactor wires it up thinking it's the collector, it will wipe prior matches.
10. **Pure-filler-line streak break** — see §5.4.
11. **`_telemetryLoggedMatches` keyed as `lineIdx+':'+word`** ([player.js:1864,1890](static/player.js:1864)) — if the same lyric word appears twice on the same line, only the first match is logged. Telemetry undercounts match attempts in chorus lines.
12. **`_readVadRms` uses `getFloatTimeDomainData` every 100 ms regardless of focus** ([player.js:1421](static/player.js:1421)) — fine for foreground tab; in background tab `setInterval` throttles but AnalyserNode still holds audio context. Minor.
13. **`setInterval(updateLyrics, 100)` runs forever** ([player.js:2278](static/player.js:2278)) — never cleared, even after game ends or on navigation (SPA-within-page is not relevant here, but if the page is reused via BFCache it keeps firing).
14. **`audio.play().catch(() => {})`** swallows errors silently in three places ([player.js:2365, 2411, 2432](static/player.js:2365)). Autoplay policy blocks are indistinguishable from codec failures.
15. **`document.getElementById('score-pct')` etc. in `_updateRunningScore`** ([player.js:1717](static/player.js:1717)) — no null check. If the header element is removed, scoring crashes.
16. **`console.log` leftover in production toggle** ([player.js:2347](static/player.js:2347)).
17. **`maxAlternatives = 3`** ([player.js:635](static/player.js:635)) — `_collectMatches` iterates alternatives at [player.js:667-669](static/player.js:667), so this feeds the union-match. Good. But only does so for the *latest* result; final transcripts from earlier results silently discard their alternatives.
18. **`_searchWindowMax` not reset on seek** — silently contaminates the per-line diagnostic telemetry (also under F-5).
19. **`audio.src = '/audio?t=' + Date.now()`** ([player.js:2192](static/player.js:2192)) cache-busts every page load but does not catch the case where `/audio` returns 404 (no song loaded) — browser will show a silent broken player. `audio` element errors are not handled.
20. **`skipFwd`** uses `audio.duration || 0` ([player.js:2299](static/player.js:2299)) — if `duration` is `NaN` (metadata not yet loaded) the `Math.min(0, …)` resets to 0 unexpectedly.

---

## 7. Performance Audit

Ordered by user impact.

1. **`updateLyrics` + `updateHotWord` every 100 ms** ([player.js:2278, 1469](static/player.js:2278)) — does up to two `querySelectorAll` (`.lyric-line`), per-line `classList.remove/add`, AnalyserNode `getFloatTimeDomainData`, RMS math, optional DOM HUD update, and a linear scan over `wordTimings` every tick. For long songs (300+ lines) this is cheap per-tick but consistently burns CPU even during instrumental sections. Consider: (a) bailing the interval entirely when `audio.paused`; (b) memoising `lines = lyricsScroll.querySelectorAll('.lyric-line')` outside the interval and invalidating only on `renderLyrics*`.

2. **`normalizeWords(transcript)` recomputed on every event** — called from `onresult` (every SR tick), `_collectMatches`, `_collectMatchesWhisper`, `_matchHotWord`, `_lateScoreLine`, `_lateUpgradeFromWhisper`, `_debugLog`. Each call re-splits and re-normalizes the *entire* transcript. For a 4-minute song with continuous ASR this reaches tens of thousands of word-splits. Cache the normalized token array and invalidate on append.

3. **`whisperBuffer` unbounded** — F-7. Each chunk response re-normalizes a growing string.

4. **`lyricsScroll.querySelectorAll('.lyric-line')` called in ~8 hot paths** without caching ([player.js:950, 1053, 1292, 1393, 1642, 1762, 2260, 2269](static/player.js:950)). On line change, all of these re-query.

5. **`doubleMetaphone(target)` recomputed on the spoken side on every match** — the spoken side uses `_spokenLRU` (size 50, [player.js:162](static/player.js:162)), but when an LRU miss on a repeated spoken word fires mid-song it re-runs ~100 lines of switch logic. Target side is memoized in `timing.phonetic` ([player.js:376](static/player.js:376)) — good. An LRU of 50 is tight for a fast rap song with high vocab; 200-500 would be cheap.

6. **`_debugLog` and `_renderDebugHud` run per ASR event when `_kDebug` is true** — fine when off (fast path at `if (!window._kDebug) return`). Not a production concern.

7. **`setTimeout(() => flash.remove(), 1300)`** per line score — fine. `setTimeout` for recap-removal (900 ms) — fine.

8. **`url = URL.createObjectURL(blob); a.click(); revokeObjectURL(url)`** in `_downloadTelemetry` ([player.js:2035-2042](static/player.js:2035)) — some browsers revoke too aggressively before the download actually starts. Safer: revoke on a short `setTimeout(…, 1000)`.

No critical performance bugs. The project's user-visible latency issues (per the retrospective) are fundamentally algorithmic (SR backlog, Whisper CPU slowness), not wasteful-rendering issues.

---

## 8. Documentation and Repo Organization Audit

### What's stale
- [README.md:63](README.md:63) — Whisper defaults wrong (covered in F-10).
- [README.md:37-39](README.md:37) — "Prerequisites: NVIDIA GPU with CUDA support" is false.
- [README.md:68-84](README.md:68) — Project Structure listing does not mention `docs/`, `output_telemetry/`, or the `src/` orphan.
- [README.md:10-11](README.md:10) — Describes Whisper as "high-accuracy word-level timestamps" and claims CUDA; retrospective notes CPU fallback is the norm and Whisper contributes ~2% of promotions.
- [AGENTS.md](AGENTS.md) — No env-var section; no `tests/test_telemetry.cjs` entry.
- Multiple `docs/plans/2026-03-17-telemetry-*` files describe telemetry in overlapping design docs.
- `docs/plans/2026-04-20-codex-has-been-doing-lucky-coral.md` is the plan the retrospective says to revert; it currently reads as the canonical direction.

### What should be merged
- `docs/retrospectives/2026-04-20-*.md` + `docs/session-learnings/2026-04-20-*.md` → one file.
- Each `docs/plans/YYYY-MM-DD-<topic>-design.md` + `<topic>-implementation.md` pair → one "status + design + actual-implementation-notes" file.
- `AGENTS.md` → `CLAUDE.md` (one guide).
- `docs/codex_audits/Codex-Audit-4-6-2026.txt` → `docs/audits/2026-04-06-codex-audit.md`, sibling to this file.

### What's missing
- **Architecture overview** — one diagram and 500 words explaining: page load → sessionStorage → prep overlay → audio load → interval poll → game start → recognition + whisper → hot-word + collect-matches → prevLine overlap → _scoreLine → end-of-song. Right now this only exists spread across 39 design docs.
- **Scoring algorithm reference** — the canonical rule for how a word becomes "matched", what each of the six scoring methods (exact/phonetic/contraction/slang/edit1/edit2) counts, and what the 70% weighted threshold means. Critical for anyone maintaining the matching code.
- **Telemetry schema doc** — what each field in the telemetry JSON means, and how to replay/analyze them. Currently implicit in `_initTelemetry`, `_logAsr`, `_logMatch`, `_logPromotion`, `_logTransition`.
- **Known limitations** — VAD gameability, CUDA fallback, lrclib first-hit risk. Better to surface these in the README than leave them in audits.

### Recommended canonical doc structure
```
docs/
├── README.md                          # one-page: how to find the right doc
├── architecture.md                    # new — the big picture
├── algorithms/
│   ├── scoring.md                     # new — canonical scoring spec
│   ├── matching.md                    # new — word-match strategies & scores
│   └── sync.md                        # new — tempo/window/chunk rationale
├── operations/
│   ├── whisper.md                     # new — env vars, fallback, common failures
│   └── telemetry.md                   # new — schema & analysis howto
├── audits/
│   ├── 2026-04-06-codex-audit.md      # moved from codex_audits/
│   └── 2026-04-20-full-repository-autopsy.md   # this file
├── plans/                             # consolidated: one file per feature iteration
│   ├── README.md                      # timeline
│   └── <date>-<feature>.md            # each plan now one file, not two
└── retrospectives/
    └── 2026-04-20-scoring-regression.md  # merged from retro + session-learnings
```

---

## 9. Prioritized Cleanup Plan

### Phase 0 — Immediate safety (today)
- **P0.1** Decide the fate of the uncommitted `player.js` rollout. Two acceptable paths: (a) revert to `836cb2d` and cherry-pick the safe-salvage items from the retrospective; (b) commit to a dead-named branch and force the working tree back to `836cb2d`. Do not do anything else until this is resolved — F-1.
- **P0.2** Fix README defaults — F-10. 15-minute edit.
- **P0.3** Delete the zero-risk dead assets (src/, package.json, demo.json, temp/write_tests.py, temp/instrumental.wav, temp/demucs_out/, .worktrees/). One commit.

### Phase 1 — Cleanup wins (this week)
- **P1.1** Delete `_matchTranscript` method.
- **P1.2** Merge `retrospectives/` + `session-learnings/` 2026-04-20 docs into one.
- **P1.3** Merge each `*-design.md` + `*-implementation.md` plan pair into one file.
- **P1.4** Wire `tests/test_telemetry.cjs` into CI OR delete it. (Recommend delete — it asserts nothing real.)
- **P1.5** Add `try/catch` around the module-top-level `JSON.parse(sessionStorage)` — F-8.
- **P1.6** Move `docs/codex_audits/` to `docs/audits/` and rename to `.md`.

### Phase 2 — Structural refactors (next two weeks)
- **P2.1** Extract a pure `scoring.js` module from `player.js`. Move `editDistance`, `doubleMetaphone`, `wordsMatch`, `wordsMatchScore`, `normalizeWord`, `normalizeWords`, `estimateSyllables`, `interpolateWordTimings`, and crucially the arithmetic core of `_scoreLine`. Keep DOM/audio glue in `player.js`. Add Node tests.
- **P2.2** Factor `_resetLineState()` used by both `onSeek` and `setActiveLine` — F-5.
- **P2.3** Factor `_resetSessionCounters()` used by `start()` and `replayGame()` — F-9.
- **P2.4** Cache `normalizeWords(transcript)` at append time instead of recomputing on every consumer — §7 item 2.
- **P2.5** Cap `whisperBuffer` to last 200 words — F-7.

### Phase 3 — Algorithm validation and hardening (after P2 lands)
- **P3.1** Write the scoring regression test matrix against the extracted module (P2.1). Include the 30-case table for `wordsMatchScore`, 15 cases for `_scoreLine` arithmetic.
- **P3.2** Fix F-2 (repeated-target false credit) with a regression test.
- **P3.3** Decide VAD product intent and implement F-3 fix.
- **P3.4** Fix F-4 (stale-line Whisper routing).
- **P3.5** Fix F-6 (double-counted weight in late upgrade) — probably solved by P2.1 since both rules will live in one function.
- **P3.6** Add lrclib ranking test coverage (§5.1).
- **P3.7** Add `/whisper-status` prewarm failure-path test.

### Phase 4 — Longer-term modernization (after stabilization)
- **P4.1** Write the missing architecture / algorithms / operations docs (§8).
- **P4.2** Evaluate whether to keep the dual-track (browser SR + Whisper) model given Whisper is CPU-only on this machine and contributes ~2% per the retrospective.
- **P4.3** Consider whether `player.js` should be split into smaller modules (recognition, matching, scoring, telemetry, ui). Only after P2 and P3 are stable.
- **P4.4** Add a small end-to-end test harness that replays a telemetry JSON to validate scoring determinism.

---

## 10. Quick Wins (each under ~1 hour)

1. Fix `README.md` Whisper defaults + prerequisites (§F-10).
2. Delete `src/` + `package.json` + `demo.json` + `temp/instrumental.wav` + `temp/demucs_out/` + `.worktrees/*` empty stubs.
3. Delete `_matchTranscript` method ([player.js:1385](static/player.js:1385)).
4. Wrap `JSON.parse(sessionStorage.getItem('songData') …)` in try/catch at [player.js:2186](static/player.js:2186).
5. Remove the `console.log` at [player.js:2347](static/player.js:2347) (or gate on `_kDebug`).
6. Bump `_spokenLRU` capacity from 50 to 256.
7. Add a null-guard in `_updateRunningScore` before `document.getElementById('score-pct').textContent`.
8. Cache `lyricsScroll.querySelectorAll('.lyric-line')` once per `renderLyrics*` and invalidate; stop re-querying in hot paths.
9. Add `_lineEnergySamples = []` and `_telemetryLoggedMatches = new Set()` to `onSeek`.
10. Consolidate `AGENTS.md` env-var gap: either add the section or point to `CLAUDE.md`.

---

## 11. "Do Not Ignore These" List

Blunt shortlist. In priority order.

1. **The uncommitted `player.js` rollout is known to be broken by the project's own retrospective.** Do not ship, do not branch off of it, do not ask Claude to "tune it forward". Revert or quarantine before anything else.
2. **Core scoring is gameable.** VAD alone grants 25% weighted credit on every hot word with any ambient noise — F-3. A silent user on an adlib-heavy line can "pass" 70% threshold. This undermines the entire portfolio-readiness pitch of the project.
3. **Repeated-target words over-credit.** A chorus line with `"no no no"` scores 3× from one spoken `"no"`. F-2.
4. **`onSeek` does not reset all per-line state.** Silent telemetry corruption and phantom scoring after mid-line seeks. F-5.
5. **Whisper response can score under the wrong line.** F-4. Silently cross-wires matching across line boundaries.
6. **Zero tests exist for the actual scoring pipeline.** `test_telemetry.cjs` asserts against stubs. `lyrics.fetch_lyrics`, `_score_candidate`, the whole `player.js` match→score→upgrade path have no direct coverage. Any "fix" to the above is operating blind until tests exist. Prioritize P2.1 + P3.1.
7. **Orphan `src/` React tree is misleading.** Flagged by the prior 4-6 audit; still not deleted. New contributors will waste time on it.
8. **Documentation drift on runtime defaults.** README says CUDA; app defaults to CPU. Trust-eroding.
9. **39 plan docs + paired design/implementation files + retro + session-learnings + audits.** The volume hides the signal. Consolidate or the next contributor will not find the one doc that matters.
10. **`player.js` is 2,434 lines with one 37-method class.** Not urgent, but every bug above would be smaller and more testable if the scoring arithmetic were a pure module. Schedule P2.1.

---

*End of audit.*
