# Deployed audio is client-side YouTube IFrame (any song), not a curated catalog

- **Status:** accepted
- **Date:** 2026-06-05
- **Related:** [ADR-0001](0001-tiered-recognizer-byo-key-deploy.md)

The core product thesis is **"sing the songs you genuinely love."** Karaokee exists to fix the karaoke-bar problem — huge catalogs that never have *your* song, the one you know cold and can shine on. So the ability to play **any** song is non-negotiable, which rules out a curated catalog. For the deployed app, the backing track plays **client-side via the YouTube IFrame Player API** (the browser streams from the user's own IP); the server downloads and holds **no audio**.

## Why not the alternatives

- **Curated bundled catalog** — betrays the thesis (and would skew to the author's rap taste); a fixed list *is* the exact karaoke-bar limitation the product reacts against.
- **Keep server-side `yt-dlp` download** — 403s from cloud IPs (SABR gating; the cookie fix needs a *local* browser), clobbers concurrent users via the single `temp/audio.webm`, and violates YouTube ToS. The IFrame Player API is the *sanctioned* embed path, so IFrame is also a compliance **upgrade**.
- **Hybrid (server fallback for embed-disabled videos)** — reintroduces all three problems for the fallback set; rejected for v1.

## Scope: "any song" = "any embeddable, synced song"

Prefer auto-generated **"… - Topic"** / audio uploads over music videos — more often embeddable, clean audio with no video intro, and they **match the LRC's reference timing** (music videos drift; the author already avoids them for this reason). On a miss (won't embed, or lrclib has no *synced* LRC), **degrade gracefully** — tell the user, let them pick another version — never break.

## Consequences

- Combined with ADR-0001 (browser-SR default), the deployed server becomes **near-stateless**: static frontend + lrclib lookup + telemetry collection — no audio download, no per-user temp file, no server inference. Cheap and simple to host.
- **Embeddability tax:** "any song" narrows to embeddable uploads; mitigated by Topic-upload preference + graceful fallback.
- **Clock-precision risk — investigated and CLEARED (spike, 2026-06-05).** The feared coarse "~250 ms-polled `getCurrentTime()`" did not materialize: in desktop Chrome it is frame-grained (~60 Hz) and *smoother* than the `<audio>.currentTime` scoring already ran on (re-anchor jitter p99 ~1.6 ms vs ~13.7 ms for `<audio>`). The clock funnels through one accessor (`static/player.js` `_now()`); no `performance.now()` interpolation layer was needed. See [`spikes/youtube-clock/NOTES.md`](../../spikes/youtube-clock/NOTES.md). **Not a risk.**
- The "paste any YouTube URL → server download" flow and local `faster-whisper` survive as **local-dev-only** capabilities.
- **Future (out of v1 scope):** some "Topic" uploads offer clean (non-explicit) versions — a later lever for broadening the audience to users who'd rather not perform explicit lyrics. Quality-of-life, not v1.

## Known reliability limitations (observed during implementation, 2026-06-06)

Building and live-testing the IFrame integration surfaced several **YouTube-platform** playback constraints inherent to client-side embedding. None are app bugs — the player, lyrics, scoring, and clock all work; it is specifically YouTube's *video stream* that gets gated. These are accepted, documented limitations for the v1 demo:

- **Per-video embeddability (the "embeddability tax" — confirmed).** Some videos return IFrame error **101/150** ("Video unavailable" / "can't be embedded") even though they play on youtube.com directly — owner/rights restrictions. Mitigation (already built): prefer **"– Topic"** uploads; the app shows a graceful "try another version" message instead of breaking.
- **Account concurrency.** A signed-in YouTube account playing in 2+ places at once triggers *"Playback paused — your account is being used in another location."* Hits users with multiple YouTube sessions/devices; a typical single-session visitor is unaffected.
- **Incognito / third-party cookies blocked.** Embedded playback can fail (perpetual spinner / "unavailable") when third-party cookies are blocked — incognito, strict privacy settings, and Chrome's longer-term 3p-cookie deprecation. A normal browser session plays fine.
- **Ads.** Logged-out / no-adblock playback may show a pre-roll ad before the song.

**Net:** reliable for the common case (normal browser, single session, an embeddable/Topic upload), with real per-video and per-context failure modes otherwise. Crucially, **scoring is independent of the audio source** — the `<audio>` local-file path (`/load-local`) bypasses all of the above and is the dev/test path (used for the Task-6 sing-test). The trigger to *revisit this ADR* (e.g., a server-side or hybrid audio source) is a measured, too-high failure rate for **typical logged-out visitors on Topic uploads** — not these individually-expected limitations.
