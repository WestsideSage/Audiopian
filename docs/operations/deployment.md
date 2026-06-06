# Deployment (getting Karaokee online)

Karaokee runs locally today (`python app.py` on your own machine). This is the plan for putting it **online so other people can play it in their browser** — the current top priority. It's written to be read by anyone; the decisions behind it live in [`docs/adr/`](../adr/).

> **Status:** in progress. **Build item #1 — client-side YouTube IFrame playback — is DONE & merged (2026-06-06)**; the remaining items below are still the map.

## The goal, in one line

Someone opens a link in **desktop Chrome**, plugs in a mic, pastes any song, and plays — without installing anything, and without it costing *you* money per player.

## The big idea: a near-stateless app

Every deployment decision points the same way — **make the server do almost nothing**, so it's cheap and simple to host:

- the song plays **straight from YouTube in the browser** (no download on the server),
- your voice is recognized **in the browser** (free) — so no transcription bills,
- nothing is saved per-player on the server.

That leaves the server doing just two things: hand over the web page, and look up lyrics.

## What the v1 online version looks like

| Piece | Decision | Why / where |
|---|---|---|
| **Who can play** | Desktop Chrome/Edge + a mic. Mobile and other browsers get a friendly "open this on desktop Chrome" page. | Free speech recognition only works there. ([ADR-0001](../adr/0001-tiered-recognizer-byo-key-deploy.md)) |
| **Hearing you — free** | The browser's built-in speech recognition. The default for everyone, $0. | ([ADR-0001](../adr/0001-tiered-recognizer-byo-key-deploy.md)) |
| **Hearing you — sharper (optional)** | Players with an OpenAI key paste it (kept in their browser) for `gpt-realtime-whisper`. | You can't fund everyone's transcription. ([ADR-0001](../adr/0001-tiered-recognizer-byo-key-deploy.md)) |
| **The music** | Any YouTube song, played in the browser via the YouTube embed player. "Topic"/audio uploads preferred; if one won't embed or has no synced lyrics, ask for another. | Keeps "any song"; no server download, no 403s. ([ADR-0002](../adr/0002-any-song-client-side-youtube-iframe.md)) |
| **The game** | Arcade mode (combos / grade) on by default. | ([ADR-0003](../adr/0003-arcade-default-lyric-axis-frozen.md)) |
| **Scores & history** | Saved in the player's own browser (high score + match history), plus a share-image to post. No global leaderboard yet. | Keeps the server stateless. |
| **Telemetry** | Off in the online version. | Privacy + the algorithm is frozen. ([ADR-0003](../adr/0003-arcade-default-lyric-axis-frozen.md)) |

## What has to change to get there

Build items, roughly by size/risk:

1. ✅ **DONE (merged 2026-06-06) — play the backing track from YouTube in the browser.** `player.js` now drives a source-agnostic `playback` adapter (`static/playback-source.js`): a YouTube IFrame source by `videoId`, or an `<audio>` source for uploaded local files. The feared "coarse clock" was **refuted by a throwaway spike** (`spikes/youtube-clock/`) — real-Chrome `getCurrentTime()` is frame-grained (~60 Hz) and *smoother* than the old `<audio>` clock, so no interpolation was needed. Validated end-to-end (a full *Uproar* run scored honest 97% / S; deliberate wrong-lyrics 0% / D — the content-gate holds). YouTube-embed reliability limits (per-video embeddability 101/150, account-concurrency, incognito/3p-cookies, ads) are documented in [ADR-0002](../adr/0002-any-song-client-side-youtube-iframe.md); a typical normal-browser, single-session visitor is unaffected.
2. **Turn arcade mode on by default.** Right now it's off unless you've pressed **V** — `player.js:2121` reads it from browser storage, defaulting *off*, so a fresh visitor gets the non-arcade view. This default must flip. ([ADR-0003](../adr/0003-arcade-default-lyric-axis-frozen.md))
3. **The "bring your own key" flow.** Today the *server* holds the OpenAI key; online, the player supplies their own (kept in their browser). Open question: can the browser set up the live session directly with OpenAI, or does it still need the server to broker it? A quick compatibility check (CORS / the session-mint call) settles it. ([ADR-0001](../adr/0001-tiered-recognizer-byo-key-deploy.md))
4. **The "desktop Chrome only" page** for mobile/other-browser visitors. Your marketing (Shorts + Reddit) is opened mostly on phones, so this protects the funnel instead of showing them a broken page.
5. **A share-image** of the score/grade, for posting to Shorts/Reddit.
6. **Run a real web server.** Locally it uses Flask's built-in dev server, which isn't meant for the public internet — swap in a production server (`waitress` on Windows, `gunicorn` on Linux) and require **HTTPS** (the mic and speech recognition need it).

## Where to host it

Because the server is so thin (serve the page + look up lyrics), hosting is cheap:

- **Recommended for v1:** a small **always-on Flask instance on a free/cheap platform** (Render, Railway, or Fly.io). They give you a public HTTPS link, and this reuses the app almost as-is — the lyric lookup *and ranking* (`lyrics.py`) stay on the server.
- **Future optimization → fully static (free):** the only things keeping a server are serving files and ranking lyric matches. If `lyrics.py`'s ranking is ported to run in the browser **and** lrclib.net allows direct browser calls (a "CORS" check), the whole app could be a free static site with no server at all. Worth doing later; **not** needed for v1.

## Smaller things to sort before launch

- ✅ Local YouTube download via `/load` is now **developer-only** (gated behind `KARAOKEE_SERVER_AUDIO=1`); local Whisper stays a dev tool too. Neither runs online.
- Lyrics still come from lrclib.net at play time; confirm that's reliable from a cloud server.
- A friendly first run (mic-permission prompt, a suggested song or two to try).
- A short "what we collect" note (nothing, in v1) for trust.

## Deliberately NOT in v1 (deferred)

- **Mobile / phones** — a separate effort (the "grand vision" is any device with a mic).
- **Global leaderboard & accounts** — needs a database; revisit *together* later (and it would re-raise cheese concerns — see [ADR-0003](../adr/0003-arcade-default-lyric-axis-frozen.md)).
- **Collecting telemetry online** — only if it's ever made opt-in and fully transparent.
- **Pitch / melody scoring & timing alignment** — the next *algorithm* frontier, parked behind shipping (see the [research](../research/2026-06-04-core-loop-modernization.md)).
