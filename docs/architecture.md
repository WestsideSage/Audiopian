# Architecture

How Karaokee works under the hood — written so anyone can follow it, with code references (`file:line`) for developers.

**The one-sentence version:** Karaokee is a small web server (Python + Flask) that sends a web page to your browser; from there, almost everything happens *in your browser* — the music plays, your microphone listens, your singing is turned into text, that text is matched against the song's lyrics, and you get a score.

> **How it runs.** You start it with `python app.py`. The backing track now **plays straight from YouTube inside the browser** — the client-side YouTube IFrame player (merged 2026-06-06) — with a plain `<audio>` element as the fallback for uploaded local files. That's the first and biggest piece of the **"near-stateless" online version** (the server just serves the page + looks up lyrics; your voice is handled in the browser). The remaining online pieces (hosting, arcade-on-by-default, bring-your-own-key, etc.) are tracked in [`docs/operations/deployment.md`](operations/deployment.md), with the decisions in [`docs/adr/`](adr/).

## The server side (`app.py`)

`app.py` is the Python program that answers web requests. Each "route" below is just a URL the browser can call:

- `/` and `/player` — hand over the two web pages (the search page and the game page).
- `/load` — takes a YouTube link, finds matching time-synced lyrics, and returns the song's `videoId` so the **browser plays it via the YouTube IFrame** (no server download by default; set `KARAOKEE_SERVER_AUDIO=1` to re-enable the old dev download).
- `/load-local` — lets you upload your own audio file + lyrics instead of using YouTube (handy for testing).
- `/audio` — streams a downloaded/uploaded song to the browser. Used **only by the local `<audio>` path** now (uploaded files, or the dev download); the YouTube path streams from the IFrame instead.
- `/transcribe` — turns a chunk of recorded audio into text using a speech-recognition model on the server.
- `/realtime-transcription-session` — sets up a secure, short-lived connection so the browser can stream your voice straight to OpenAI's live transcription.
- `/whisper-status`, `/retry-lyrics`, `/search`, `/telemetry` — transcriber-loading status, re-fetching lyrics, YouTube search, and saving a game's stats for later analysis.

Two helper files keep `app.py` focused: `downloader.py` (everything about YouTube) and `lyrics.py` (finding and parsing the lyrics).

## Turning singing into text ("transcription")

Transcription — also called **ASR (automatic speech recognition)** — means turning your voice into written words. Karaokee can use three different engines, chosen by the `WHISPER_PROVIDER` setting:

- `local` — a model called **Whisper** running on your own computer (the default).
- `openai` — OpenAI's cloud transcription, one chunk at a time.
- `openai_realtime` — OpenAI's *live* transcription (`gpt-realtime-whisper`), streamed continuously from the browser.

Full details: [`docs/operations/whisper.md`](operations/whisper.md).

## The browser side (`static/`)

The game page loads a series of small JavaScript files, each with one job. All of them except `player.js` are written so they can be tested on their own without a browser — which keeps them reliable. In load order: `sync-helpers.js`, `vad-helpers.js`, `match-helpers.js`, `scoring.js`, `phrase-engine.js`, `realtime-whisper.js`, `scoring-arcade.js`, `telemetry-helpers.js`, `lyric-paint-helpers.js`, `scoring-session.js`, `commit-helpers.js`, the neural-VAD library (`vendor/vad/…`), and finally `player.js`.

## Hearing you sing

**Knowing *when* you're singing** (versus silent) is called **voice-activity detection (VAD)**. Karaokee uses a small AI model (called Silero, bundled in `vendor/vad/`) that listens and signals "started singing" / "stopped singing" (`player.js:162`). If that model can't load, it falls back to a simpler method that just measures how loud the mic is (`player.js:163`).

**Hearing *what* you sing** uses two systems at once, for the best of both:

- your browser's built-in speech recognition — fast, gives rough text instantly (`player.js:419`);
- the Whisper engine above — slower but more accurate, and it can fill in words the fast one missed.

For the live OpenAI path, `commit-helpers.js` picks the smart moment to send your audio off for transcription — at the natural pause when you finish a phrase or take a breath, instead of chopping it every 0.7 seconds. That way whole phrases get transcribed and read correctly.

## Turning that into a score

`player.js` runs the screen — it plays the music, highlights the current line, listens to the mic, and shows results. But it hands the actual *scoring* to a separate piece of code, `scoring-session.js`, which tracks the whole game from start to finish. As text comes in, `player.js` passes it over (`ingestFinal` for confirmed words — `:447` for the browser, `:774` for Whisper); the scorer works out which lyrics you hit and sends back little "draw this on screen" messages that `player.js` paints.

The scorer leans on three specialists:

- `scoring.js` — decides whether a word you sang matches a lyric, even when it's misheard or spelled oddly (it knows "night" and "knight" sound the same).
- `phrase-engine.js` — groups lyrics into phrases, picks the **key words** (called "anchors") that prove you sang a line, and can credit words that arrive late.
- `scoring-arcade.js` — the game layer: combos, points, and your letter grade.

## Two scores, on purpose

Karaokee shows two different numbers:

- the **Honest %** — how much of the lyrics you actually sang;
- the **Arcade** score — points, combos, and a grade (the fun, game-y layer).

When the slow-but-accurate recognizer confirms a word *after* a line has already passed, Karaokee fairly raises your **Honest %** — but it does *not* go back and boost the arcade combo you already locked in. (The team nicknamed this "blessed divergence.") The shared vocabulary for all of this lives in [`CONTEXT.md`](../CONTEXT.md).

## What gets remembered

- The scoring for one playthrough lives in memory while you play, and is thrown away afterward.
- A few small things are saved **in your browser** (not on any server): your difficulty choice, a per-song timing nudge, and your best score per song. (Scoring is a single arcade path now — the old `karaokee_v2` / **V**-key A/B toggle to the legacy V1 scorer was retired 2026-06-08.)

## Things to keep in mind

- The YouTube path plays **client-side via the IFrame** (no server-side audio file). The local `<audio>` path still keeps a single `temp/audio.*` (overwritten per `/load-local` upload, or per `/load` when `KARAOKEE_SERVER_AUDIO=1`) — fine for one person on one computer, and the reason the deployed version uses the IFrame instead.
- The local Whisper model is slow on a computer without a graphics card (GPU); it automatically downshifts to the slower-but-works CPU mode when needed.
- The real app lives in `static/`. An old, abandoned version (`src/`) was deleted during the April cleanup.
