• SECTION 1 — EXECUTIVE VERDICT

  The idea is genuinely interesting, not gimmicky, because real-time lyric judgment is actually a hard product and
  engineering problem. The current repo, though, does not feel technically credible enough to support the precision
  implied by its UI and scoring. As a portfolio piece it is only borderline-worthy if presented honestly as a prototype
  with telemetry and hard lessons, not as a finished or trustworthy karaoke engine. The biggest credibility risk is that
  the app presents confident scoring on top of heuristic, inconsistent, and in a few places plainly gameable judging
  logic.

  SECTION 2 — TOP FINDINGS (MOST IMPORTANT)

  1. Severity: Critical. Category: Correctness/Product. Files: /C:/GPT5-Projects/Karaokee/static/player.js:1119, /C:/
     GPT5-Projects/Karaokee/static/player.js:1180, /C:/GPT5-Projects/Karaokee/static/player.js:541. Evidence: a hot word
     is marked correct at full score when mic energy is high, and a line becomes scoreable on any ASR event before
     actual transcript quality is checked. Why this matters: humming, noise, or bad interim ASR can become real points.
     Recommended fix: make VAD hits provisional only, require later ASR confirmation, and expire unconfirmed provisional
     hits before scoring.
  2. Severity: Critical. Category: Product/UX. Files: /C:/GPT5-Projects/Karaokee/static/player.js:1675, /C:/GPT5-
     Projects/Karaokee/static/player.js:1693, /C:/GPT5-Projects/Karaokee/static/player.js:904, /C:/GPT5-Projects/
     Karaokee/output_telemetry. Evidence: the active line advances solely from audio.currentTime, and transitions are
     still logged as score; the telemetry samples I checked log only score triggers. Why this matters: this is not
     really Guitar Hero-style gated play, it is timed subtitles with post-hoc coloring. Recommended fix: separate
     display timing from judge state and either implement real gating/hold logic or stop claiming gated gameplay.
  3. Severity: Critical. Category: Correctness/UX. Files: /C:/GPT5-Projects/Karaokee/static/player.js:1718, /C:/GPT5-
     Projects/Karaokee/static/player.js:1729, /C:/GPT5-Projects/Karaokee/static/player.js:1739, /C:/GPT5-Projects/
     Karaokee/static/player.js:1959. Evidence: pause, skip, and seek only change audio transport; they do not suspend or
     reset transcript, whisper, VAD, or scoring state. Why this matters: users can corrupt or farm the score by pausing,
     talking, or rewinding. Recommended fix: ranked mode must suspend judging on pause and hard-reset or explicitly
     switch to practice mode on seek.
  4. Severity: Critical. Category: Performance/Architecture. Files: /C:/GPT5-Projects/Karaokee/app.py:20, /C:/GPT5-
     Projects/Karaokee/app.py:145, /C:/GPT5-Projects/Karaokee/static/sync-helpers.js:79, /C:/GPT5-Projects/Karaokee/
     static/player.js:650, /C:/GPT5-Projects/Karaokee/static/player.js:693. Evidence: Whisper is lazy-loaded as large-
     v3-turbo on CUDA only, chunks are 0.75s to 2.0s long, and normal chunks are dispatched without backpressure. Why
     this matters: the latency floor is already high before inference starts, and slow inference can queue requests
     indefinitely. Recommended fix: configurable model/device, prewarm before play, bounded queue depth, and a streaming
     or batched transcription path.
  5. Severity: High. Category: Correctness/UX. Files: /C:/GPT5-Projects/Karaokee/static/index.html:143, /C:/GPT5-
     Projects/Karaokee/static/player.js:481, /C:/GPT5-Projects/Karaokee/static/player.js:1103, /C:/GPT5-Projects/
     Karaokee/static/player.js:1678, /C:/GPT5-Projects/Karaokee/static/player.js:1757. Evidence: the “per-video” offset
     key uses ?v= even though the player URL never gets that param, and the offset only affects hot-word matching while
     displayed lyric selection ignores it. Why this matters: the sync control is misleading and leaks across songs.
     Recommended fix: store a real song ID in session or URL and apply offset consistently to display, transitions, and
     judging.
  6. Severity: High. Category: Product/Correctness. Files: /C:/GPT5-Projects/Karaokee/lyrics.py:20, /C:/GPT5-Projects/
     Karaokee/lyrics.py:5, /C:/GPT5-Projects/Karaokee/src/parser/parseLrc.ts:77. Evidence: the backend takes the first
     parseable lrclib result, the runtime parser only handles a narrow LRC format, plainLyrics fallback is effectively
     dead, and the repo already contains a stronger parser that is unused. Why this matters: wrong or partially parsed
     lyrics instantly destroy trust in the whole game. Recommended fix: rank lyric candidates by title/artist/duration
     similarity, use synced lyrics only for game mode, and share one robust parser.
  7. Severity: High. Category: Correctness/UX. Files: /C:/GPT5-Projects/Karaokee/static/player.js:447, /C:/GPT5-
     Projects/Karaokee/static/player.js:1800, /C:/GPT5-Projects/Karaokee/static/player.js:1973. Evidence: game mode
     remains active after ended, then replayGame() calls start() even though start() immediately returns when already
     active. Why this matters: replay is likely broken exactly where a demo should feel cleanest. Recommended fix: add
     an explicit reset/end-state path and call it before replaying.
  8. Severity: High. Category: Testing/Resume Signal. Files: /C:/GPT5-Projects/Karaokee/package.json:6, /C:/GPT5-
     Projects/Karaokee/tests/test_match_helpers.cjs:97, /C:/GPT5-Projects/Karaokee/tests/test_telemetry.cjs:1. Evidence:
     npm test points to Vitest, the JS tests are actually ad hoc CJS scripts, node tests/test_match_helpers.cjs
     currently fails on maxEditDistance(10), and the telemetry “tests” only validate stub objects they create
     themselves. Why this matters: the test posture looks stronger than it is. Recommended fix: consolidate on one
     runner and test imported runtime code, not synthetic stand-ins.
  9. Severity: Medium/High. Category: Maintainability/Resume Signal. Files: /C:/GPT5-Projects/Karaokee/app.py:11, /C:/
     GPT5-Projects/Karaokee/app.py:36, /C:/GPT5-Projects/Karaokee/app.py:41, /C:/GPT5-Projects/Karaokee/src/hooks/
     useGameEngine.ts:65, /C:/GPT5-Projects/Karaokee/src/hooks/useLyricSync.ts:34. Evidence: the app serves static HTML/
     JS in production while a separate React/TypeScript frontend skeleton sits unused in src/. Why this matters: the
     repo reads like half a migration and weakens confidence in ownership and direction. Recommended fix: choose one
     frontend architecture and delete or finish the other.
  10. Severity: Medium. Category: Product/Maintainability. Files: /C:/GPT5-Projects/Karaokee/app.py:64, /C:/GPT5-
     Projects/Karaokee/static/player.html:321, /C:/GPT5-Projects/Karaokee/tests/test_app.py:111. Evidence: vocal
     separation is disabled in the load flow, hidden in the UI, and the stale-thread test is skipped. Why this matters:
     it makes the project look partially fake-complete. Recommended fix: either cut it from the story entirely or
     restore it end-to-end with real tests.

  SECTION 3 — PRODUCT AUDIT

  - The value proposition is clear: sing the right words at the right time. The problem is not clarity of concept; it is
    trust in judgment.
  - The experience is likely intuitive for the first minute and then starts to feel arbitrary, because the app does not
    explain whether a green word came from real transcript alignment, fuzzy matching, or raw VAD timing.
  - The scoring loop currently feels more arbitrary than meaningful. Synthetic word timings, naive lyric selection,
    provisional VAD hits, and transport exploits all make the score feel cosmetic.
  - Biggest UX trust-breakers: wrong lyrics, broken sync offset, false green words, live seek controls during scoring,
    and Chrome-only browser recognition as an undeclared hard dependency.
  - Product decisions that feel underthought: keeping ranked scoring live while transport controls stay fully editable,
    relying on first lyric search hit, and not having a pre-song “verify lyrics/sync/mic” step.
  - What makes a user bounce: one obviously wrong judged line, one wrong lyric file, or one long cold-start where the
    app looks “real-time” but responds late.
  - The 3 most important product improvements are: add a preflight verification/calibration step, make scoring
    confidence-aware and explainable, and split “ranked mode” from “practice mode” so seeking and offset tweaks do not
    poison scores.

  SECTION 4 — ARCHITECTURE AUDIT

  - Separation of concerns is weak. /C:/GPT5-Projects/Karaokee/static/player.js is a 1978-line catch-all for DOM,
    transport, recognition, VAD, scoring, telemetry, and lifecycle.
  - State management is fragile. GameMode mutates shared transcript strings, maps, timers, and DOM state directly
    instead of running through a small deterministic state machine.
  - The real-time pipeline is not a pipeline so much as three overlapping heuristics: browser speech recognition,
    Whisper chunk requests, and VAD optimistic hits, all writing into the same match state.
  - Lyric alignment logic is synthetic. Word times are guessed by syllable distribution, not measured alignment, so the
    scoring math looks more precise than the underlying signal.
  - Error handling is mostly silent fallback. Whisper errors become empty 503s, lyric fetch failures collapse to empty
    arrays, and the UI does not surface which subsystem is currently carrying the game.
  - Async/event handling is brittle: timers, setInterval, setTimeout, browser SR callbacks, fetches, and audio events
    all interact without a single authoritative lifecycle.
  - Coupling between UI and core logic is high. You cannot test most judging behavior without DOM and audio objects
    because the game logic updates spans directly.
  - Extensibility without chaos is poor. Adding pitch scoring, multilingual lyrics, or true practice/ranked modes would
    force more conditionals into a file that is already too central.
  - Overengineering: docs, telemetry, and heuristic layers. Underengineering: state boundaries, reproducibility, and the
    actual trust model of scoring.
  - Hidden single points of failure: lrclib result quality, Chrome speech recognition availability, local GPU Whisper
    viability, and single shared temp files for audio.

  SECTION 5 — CORRECTNESS + EDGE CASES

  - Timing drift: partially handled. Wide windows and overlap exist, but the offset control is inconsistent, so display
    and judgment can diverge.
  - Partial lyric matches: partially handled. Fuzzy, phonetic, slang, contraction, and phrase matching exist.
  - Repeated words: partially handled. There is a special case for adjacent duplicates, but not a robust repeated-token
    alignment strategy.
  - Filler sounds and non-lexical vocalizations: partially handled in text matching, likely fail in VAD mode because
    energy alone can create hits.
  - Silence: likely fail product-wise. The app avoids some penalties by skipping zero-ASR lines, but that hides failure
    instead of judging it.
  - Background noise and speaker bleed: likely fail. VAD thresholding is simple and scoreable hits can be created from
    energy, not content.
  - Microphone issues: partially handled. Permission denial is surfaced; weak quality or bad device selection mostly
    degrades silently.
  - Lag spikes: likely fail. There is no bounded queue for ordinary Whisper chunks.
  - Skipped lines and seeking: likely fail. Transport is not integrated with scoring state.
  - Users slightly early or late: partially handled. Windows are intentionally generous.
  - Pronunciation variance: partially handled. The custom phonetic/fuzzy helpers are the best part of the core judge.
  - Score inflation or unfair penalties: likely fail. Provisional VAD hits, weak edit matches, and skipped lines all
    distort fairness.
  - State desync between displayed lyric and judged lyric: likely fail. The offset bug alone is enough to create this.

  SECTION 6 — PERFORMANCE / LATENCY REVIEW

  - The likely bottlenecks are Whisper cold start, per-chunk HTTP round trips, chunk sizes of 0.75s to 2.0s, and
    unbounded normal-chunk dispatch.
  - /C:/GPT5-Projects/Karaokee/static/audio-processor.js:10 through /C:/GPT5-Projects/Karaokee/static/audio-
    processor.js:70 use push/splice-heavy JS arrays inside the AudioWorklet. That is not how you build a low-GC audio
    path.
  - There is needless recomputation. Transcript strings grow over the whole song and are repeatedly normalized and
    rescanned.
  - The app runs two recognition paths at once. Even if that improves recall, it increases CPU, coordination complexity,
    and timing inconsistency.
  - Load-time network dependence is obvious for lyrics and YouTube metadata/audio. Runtime dependence on browser speech
    recognition behavior is outside the repo’s control.
  - Debug telemetry can get very large; the sampled files in /C:/GPT5-Projects/Karaokee/output_telemetry show tens of
    thousands of match records per song.
  - I cannot fully verify actual latency from static inspection. What needs profiling: capture-to-green-word latency,
    Whisper cold-start time, request queue depth over time, dropped/late chunk count, AudioWorklet callback cost, and
    CPU/GPU usage on the target machine.

  SECTION 7 — TESTING + VERIFICATION

  - I ran python -m pytest: 32 passed, 1 skipped. That covers mocked Flask routes and a few small Python helpers.
  - I ran node tests/test_sync_helpers.cjs: passed. I ran node tests/test_match_helpers.cjs: failed on
    maxEditDistance(10) expecting 3 but runtime returns 2. I ran node tests/test_telemetry.cjs: passed, but it only
    validates stub objects it creates itself.
  - What is tested: route shells, simple downloader parsing, simple LRC parsing, Demucs subprocess wrappers, and some
    isolated helper logic.
  - What is not tested: the actual game loop, browser speech recognition behavior, Whisper queueing, DOM state
    transitions, replay, pause/seek, offset handling, lyric candidate selection, and end-to-end scoring fairness.
  - The structure is only easy to test where logic escaped into helpers. The core loop is hard to test because it is
    fused to DOM and browser APIs.
  - The 5 highest-value tests to add first:

  1. VAD hits must remain provisional and not count unless later ASR-confirmed.
  2. Pause and seek must suspend or reset scoring/transcript state deterministically.
  3. Offset changes must affect displayed line, hot word, and scoring consistently for the same song ID.
  4. Lyric selection must reject obviously wrong lrclib candidates and parse multi-tag/offset LRC correctly.
  5. Replay after ended must fully reset state, score, timers, and buffers.

  - The 3 integration tests most likely to catch embarrassing demo failures:

  1. Full browser test of a fast repeated-word line with mocked SR and /transcribe responses, verifying only the
     intended words turn green.
  2. Start game, pause, talk into mic, seek back, resume, and assert the score does not inflate.
  3. Load a song with two plausible lyric candidates and verify the chosen lyrics match title/artist/duration
     constraints before game mode starts.

  SECTION 8 — MAINTAINABILITY REVIEW

  - Another engineer could take this over, but not comfortably.
  - Repo organization feels stitched together: production static frontend, orphaned src/ React path, 32 plan docs in /
    C:/GPT5-Projects/Karaokee/docs/plans, and no top-level README to explain the real architecture.
  - Naming is inconsistent. The code mixes normal and medium tempo vocabularies and several generations of feature
    ideas.
  - Duplication is real: two LRC parsers, two frontend directions, and multiple disabled feature blocks.
  - Readability is uneven. The helper files are understandable; the main game file is not.
  - Configuration hygiene is weak: /C:/GPT5-Projects/Karaokee/requirements.txt is unpinned, /C:/GPT5-Projects/Karaokee/
    start.bat assumes python, and /C:/GPT5-Projects/Karaokee/app.py:198 runs Flask in debug mode.
  - The codebase does not feel intentional yet. It feels like a prototype that kept accumulating heuristics and
    alternate implementations without a cleanup pass.

  SECTION 9 — PORTFOLIO / HIRING-MANAGER LENS

  - What would impress me: the problem choice, the existence of real gameplay telemetry in /C:/GPT5-Projects/Karaokee/
    output_telemetry, the custom fuzzy/phonetic matching work, and the fact that the author actually tried to instrument
    a hard real-time problem instead of building another CRUD app.
  - What would make me doubt engineering judgment: precise scoring claims without a trustworthy judge, dead code paths,
    disabled marquee features left in place, and a test story that sounds better than it is.
  - Does the AI-assisted origin show in a bad way: yes. The signs are duplicate implementations, huge plan-doc volume,
    commented-out feature blocks, inconsistent abstractions, and tests that validate shapes more than behavior.
  - The 3 changes that would most increase resume/interview value are: refactor to a deterministic judgment engine with
    a testable state machine, publish a short benchmark/evaluation report for latency and scoring accuracy, and clean
    the repo down to one frontend path with reproducible setup.
  - The story the author should tell: “I built a real-time lyric-matching prototype, instrumented it, discovered where
    naive ASR heuristics break, and then hardened the judge and architecture based on telemetry.”
  - What should absolutely not be claimed on a resume: production-ready real-time lyric detection, trustworthy karaoke
    scoring, robust cross-browser support, strong automated frontend test coverage, or a finished React/Vite frontend.

  SECTION 10 — “CUT THIS / KEEP THIS / FIX THIS FIRST”

  - Cut This: the unused React/Vite path unless it becomes the real frontend; dead plainLyrics fallback behavior;
    disabled vocal-separation code if it is not being shipped; the telemetry schema stub test.
  - Keep This: the core concept; the telemetry corpus; the extracted sync and match helper modules; the stronger
    TypeScript LRC parser as the basis for a shared runtime parser.
  - Fix This First: make VAD provisional instead of scoreable, integrate transport controls with game state, repair
    offset handling end-to-end, make Whisper latency bounded and configurable, and add lyric-candidate verification
    before game mode.

  SECTION 11 — CONFIDENCE + UNKNOWNS

  - Confirmed from code: VAD can produce full-credit hits; active-line progression is time-driven; pause/seek are not
    integrated with scoring state; replay is logically broken; offset storage is not truly per-song and offset
    application is incomplete; Whisper is CUDA-only and cold-loaded; vocal separation is disabled in the main flow; the
    JS helper test suite is already drifting.
  - Inferred but plausible: background noise and humming will inflate scores in practice; latency will feel fake on
    weaker hardware or cold start; wrong lyric selection will happen often enough to hurt trust; the dual-ASR setup will
    behave inconsistently across browsers and machines.
  - Unknown without runtime testing: actual median word-judgment latency on the target PC, real false-positive/false-
    negative rates with headphones versus speakers, how often Chrome speech recognition behaves acceptably for rap
    versus normal vocals, and whether the current gameplay is fun once the judging becomes trustworthy.