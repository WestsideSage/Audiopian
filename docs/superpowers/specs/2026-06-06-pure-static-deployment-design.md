# Pure-Static Deployment — Design

**Date:** 2026-06-06
**Status:** Design approved (brainstorming); pending implementation plan.
**Scope flag:** deployment / packaging change. The frozen scoring algorithm (match→reconcile→score→commit in [scoring-session.js](../../../static/scoring-session.js) / [phrase-engine.js](../../../static/phrase-engine.js) / [scoring.js](../../../static/scoring.js)) is **not** touched. The one behavioral risk area — voice-energy/VAD inputs to that path — is explicitly preserved (see §8).
**Motivation:** the next milestone is getting Karaokee online as a free, demoable portfolio piece (see [[deployment-pivot]] and [../../operations/deployment.md](../../operations/deployment.md)). [deployment.md](../../operations/deployment.md) ranks a **fully static / serverless** deployment as the best end-state and a thin PaaS as the 2nd-best stepping-stone. This spec realizes the best option: **zero server in production**, ~$0 hosting, consistent with [ADR-0001](../../adr/0001-tiered-recognizer-byo-key-deploy.md) (tiered recognizer), [ADR-0002](../../adr/0002-any-song-client-side-youtube-iframe.md) (client-side YouTube IFrame), and [ADR-0003](../../adr/0003-arcade-default-lyric-axis-frozen.md) (arcade default, lyric axis frozen).

---

## 1. Context & goal

Karaokee runs locally today via Flask ([app.py](../../../app.py)). The IFrame-playback milestone already moved backing-track playback client-side ([ADR-0002](../../adr/0002-any-song-client-side-youtube-iframe.md); merged `b735e2e`). This spec removes the *rest* of the server: the deployed artifact becomes a bundle of static files served from a CDN, with every former server job done **directly in the browser**.

**One-line goal:** someone opens a link in desktop Chrome, plugs in a mic, pastes any YouTube URL, and plays — no install, no per-player cost to us, no server to run.

### Feasibility — verified (2026-06-06)
All three external dependencies the browser must call cross-origin return permissive CORS (live `OPTIONS`/`GET` probes):

| Endpoint | Result |
|---|---|
| lrclib `GET /api/search` | `access-control-allow-origin: *` |
| YouTube `GET /oembed` | `Access-Control-Allow-Origin: <origin>` (reflected) |
| OpenAI `/v1/realtime/client_secrets` (mint) **and** `/v1/realtime/calls` (WebRTC SDP connect) — the two endpoints this app actually uses ([app.py:38](../../../app.py), [player.js:108](../../../static/player.js)) | both `access-control-allow-origin: *` + `access-control-allow-headers: authorization,content-type` |

The OpenAI result is decisive for BYO-key: the browser may send an `Authorization` header cross-origin to both the mint and the connect endpoint, so it can mint a realtime client-secret and open the session **with the user's own key, no server broker**. **Caveat:** these are CORS *preflight* results — they prove the browser *may* call the endpoints, not that an authenticated mint+connect works end-to-end. BYO-key is not "proven" until a real-key smoke passes (§12).

## 2. Decisions (locked in brainstorming)

1. **Deployment shape:** pure static / serverless. Zero server in production.
2. **Scope:** full — core static migration **+** launch polish (desktop-Chrome interstitial, score share-image) **+** the BYO-key premium recognizer lane.
3. **Python backend fate:** kept in-repo as a **local dev/test harness only** (never deployed). Its `lyrics.py` tests become golden parity inputs for the JS port.
4. **Host:** Cloudflare Pages (free, fast CDN, auto-HTTPS, GitHub-connected CI; Workers in reserve but unused).
5. **Migration approach:** **thin seams** — add browser modules, strip server fetches, leave the frozen scoring path and its contracts intact. (The fuller "recognizer-source seam" — architecture-sprint item #2 — is a deliberate post-launch follow-up, not part of this milestone.)

## 3. Goals / Non-goals

**Goals**
- Deployed artifact is 100% static; the free experience costs us $0 and needs no server.
- Preserve the **browser-SR + VAD inputs** to the frozen scoring path; validate the free lane by **product feel**, not exact parity. (The current local app may also run whisper Track 2 via `_startWhisperTrack` ([player.js:797](../../../static/player.js)); the deployed free lane is browser-SR + VAD only, so "exact parity" is neither expected nor the bar — see §12 risk #1.)
- BYO-key premium lane works entirely client-side with the user's own key.
- Every new piece is a pure, `.cjs`-testable UMD helper, matching the existing pattern.
- Local dev (`python app.py`) and the full pytest/`.cjs` suites stay green.

**Non-goals (out of scope)**
- In-app type-to-search (yt-dlp can't run client-side; replaced by paste-URL + an outbound "Search on YouTube ↗" link).
- Online telemetry (OFF per [ADR-0003](../../adr/0003-arcade-default-lyric-axis-frozen.md); the `D`-key client-side debug download may remain).
- Global leaderboard / accounts (needs a backend; re-raises cheese concerns).
- Mobile / non-Chrome play (interstitial only).
- Pitch / alignment axes (deferred behind shipping — [../../research/2026-06-04-core-loop-modernization.md](../../research/2026-06-04-core-loop-modernization.md)).
- The recognizer-source abstraction refactor (post-launch).

## 4. Architecture

Static site, two pages + JS modules + vendored VAD, served from Cloudflare Pages. Browser talks directly to four endpoints; the free recognizer is the browser Web Speech API.

| Job | Was (server) | Now (browser-direct) |
|---|---|---|
| Backing track | — (already client-side) | YouTube IFrame ([youtube-source.js](../../../static/youtube-source.js)) |
| Title / artist | yt-dlp `/load` ([downloader.py:39](../../../downloader.py)) | YouTube **oEmbed** (new `youtube-meta.js`) |
| Lyrics + ranking | `lyrics.py` via `/load` | **`lyrics-client.js`** → lrclib |
| ASR — free default | — | browser **Web Speech API** ([player.js:418](../../../static/player.js) `_setupRecognition`) |
| ASR — premium | server mints w/ our key ([app.py:148](../../../app.py)) | **browser mints w/ the user's key** → OpenAI realtime |

**Removed from the deployed artifact:** `/load`, `/search`, `/retry-lyrics`, `/load-local`, `/transcribe`, `/realtime-transcription-session`, `/whisper-status`, `/telemetry`, `/audio`. (All remain in the dev harness.)

## 5. New components

All UMD-wrapped (browser `<script>` + Node `require()`), pure where possible, each with a `tests/*.cjs`.

### `lyrics-client.js` (`window.KaraokeeLyricsClient`)
Direct port of [lyrics.py](../../../lyrics.py):
- `parseLrc(text) → [{time, text}]` — port of `parse_lrc` (same `[mm:ss.xx]` regex, drops empty text).
- `tokenOverlap(a, b) → 0..1` — port of `_token_overlap` (`\W+` split, intersection / max set size).
- `scoreCandidate(result, title, artist, duration) → number` — port of `_score_candidate` (title×3 + artist×3 + duration proximity + synced bonus). Duration term is `0` when `duration` is falsy (the production reality — oEmbed has no duration).
- `fetchLyrics({title, artist, duration}, {fetch}) → Promise<[{time,text}]>` — port of `fetch_lyrics`: `GET https://lrclib.net/api/search?q=`, keep candidates with parseable `syncedLyrics`, rank, return best (or `[]`). `fetch` injected for testability; one retry on network error (mirrors `LRCLIB_MAX_ATTEMPTS`).

### `youtube-meta.js` (`window.KaraokeeYouTubeMeta`)
- `videoIdFromUrl(url) → string|null` — parse `watch?v=`, `youtu.be/`, `/shorts/`, `/embed/` forms.
- `parseTitleArtist(title, author) → {title, artist}` — port of `parse_title_artist` (split on first `" - "`, else `author` as artist). **Note:** the yt-dlp explicit-`artist`-tag path ([downloader.py:49](../../../downloader.py)) has no oEmbed equivalent; oEmbed relies on the title split + `author_name`.
- `fetchMeta(url, {fetch}) → Promise<{title, artist, videoId}>` — `videoIdFromUrl` + `GET https://www.youtube.com/oembed?url=…&format=json` → `parseTitleArtist(json.title, json.author_name)`.

### `song-loader.js` (`window.KaraokeeSongLoader`)
- `loadFromUrl(url, {fetch}) → Promise<songData>` — orchestrates `youtube-meta.fetchMeta` then `lyrics-client.fetchLyrics`, returning the **exact `songData` shape** index.html already writes to `sessionStorage`: `{title, artist, videoId, lyrics, lyricsError?}`. No `audioUrl` for the YouTube path (IFrame ignores it).
- On no-lyrics: returns `songData` with `lyricsError` set so the existing retry UI ([index.html:140](../../../static/index.html)) shows, exactly as the server path did.

### `key-store.js` (`window.KaraokeeKeyStore`)
- `getKey() / setKey(k) / clearKey()` — OpenAI key in `localStorage`.
- `recognizerMode() → 'free' | 'premium'` — `'premium'` iff a key is present. **This replaces server provider resolution** ([app.py:55](../../../app.py) `_resolve_whisper_provider`) and the `/whisper-status` probe for the deployed app.

## 6. Changed existing files

- **[index.html](../../../static/index.html):** `fetch('/load')` → `KaraokeeSongLoader.loadFromUrl`; `fetch('/search')` removed (paste-URL + outbound link); `fetch('/retry-lyrics')` → `KaraokeeLyricsClient.fetchLyrics`; `window.location.href='/player'` → `'player.html'`; add BYO-key field; the local-file upload UI is **hidden in the deployed build** (dev-harness only, §7). `sessionStorage` handoff itself is unchanged.
- **[player.html](../../../static/player.html):** nav `'/'`/`'/player'` left as-is (handled by `_redirects`, §9); add the interstitial container + share-image affordance.
- **[player.js](../../../static/player.js):** split mic/VAD from realtime (§8); recognizer mode from `key-store` not server; remove the `/whisper-status` probe, the local-whisper worklet/`/transcribe` branch (§8), and the `/telemetry` POST; flip arcade default ON at [player.js:2147](../../../static/player.js). (The `<audio>`/`/audio` fallback path is untouched — dev-harness only, §7.)
- **New `static/_redirects`** (§9).

## 7. Local-file upload — dev-harness only (v1)

The deployed static app is **YouTube-URL-only**; the local-file upload UI is **hidden in the deployed build** and remains available only in the Flask dev harness (`/load-local` → `/audio`, unchanged). [player.js:1951](../../../static/player.js)'s `audio.src = '/audio?t=…'` and the `AudioElementSource` ([playback-source.js](../../../static/playback-source.js)) path stay as-is — only reachable in dev (a deployed `songData` always has a `videoId`, so the IFrame branch always runs).

**Why not client-side upload in prod:** a `blob:`/object URL is revoked when the document that created it unloads, so storing one in `sessionStorage` on index.html and reading it after navigating to player.html yields a **dead URL** — object URLs are not a durable cross-page transport. Correct prod local-upload would store the `File`/`Blob` in **IndexedDB** and recreate the object URL inside player.html. Deferred until prod local-upload is actually wanted; it is not part of the YouTube-centric demo. *(This supersedes the first-round review decision to keep client-side upload via `songData.audioUrl`.)*

## 8. Recognizer in a serverless world — the mic/VAD split

**This is the one subtle behavioral risk.** Today [player.js:803-816](../../../static/player.js) `_startWhisperTrack` creates the mic stream, `AudioContext`, and `_vadAnalyser` (the RMS energy gate, read at [player.js:1208](../../../static/player.js)) **and** starts neural VAD ([player.js:816](../../../static/player.js) `_startNeuralVad`) **only inside the realtime branch**. The energy/VAD signals feed the frozen scoring path (e.g. the interim-reconciliation in-window-energy gate — the skip-leak fix in [[arcade-scoring-status]]). So naïvely gating the whole track on "key present" would starve the **free** lane of VAD/energy.

**Design — split the one method into two phases:**
- **`_startMicAnalysis()` — always-on (free and premium):** `getUserMedia` → `AudioContext` → `_vadAnalyser` (RMS) → `_startNeuralVad()`. This is everything the frozen scoring path needs for voice energy. Runs for every player, $0.
- **`_startRealtimeWhisper()` — premium only (`keyStore.recognizerMode()==='premium'`):** mint a client-secret directly at `https://api.openai.com/v1/realtime/client_secrets` with the user's key (the session-config payload currently built server-side in [app.py:148](../../../app.py) `_create_openai_realtime_transcription_session` — model `gpt-realtime-whisper`, `language: en`, optional `delay` — moves client-side), then connect via the existing [realtime-whisper.js](../../../static/realtime-whisper.js) path. It **reuses the `_whisperStream` that `_startMicAnalysis` created** (the WebRTC connection adds tracks from that stream) — so mic-analysis is a **hard prerequisite**, not a parallel path; the split must order them accordingly.

**Mode source:** `_isRealtimeWhisperProvider()` (and the `sampleRate` choice at [player.js:806](../../../static/player.js)) derive from `key-store`, not `_checkWhisperServerStatus()`. The free lane runs the AudioContext at the existing non-realtime sample rate (16000); premium uses 24000.

**Local faster-whisper path retired from the browser.** The AudioWorklet + `/transcribe` branch ([player.js:818-846](../../../static/player.js)) only ran when the *server* reported provider `local`. Since the browser's mode now comes from `key-store` and is only ever `free` or `premium` (never `local`), that branch is unreachable and is **removed from player.js** — there is one `player.js` for both dev and prod, and it never depends on a server probe. The Python `/transcribe` + faster-whisper code stays in [app.py](../../../app.py) for its existing pytest coverage but is no longer called by the player; local-dev transcription uses browser-SR (free) or a pasted key (premium), exactly like production.

**Invariant:** the inputs to the frozen scoring path (browser-SR finals/interims, RMS energy, neural VAD state) are identical to today on both lanes. Only their *triggering* and *provider source* change. Validate this **concretely with a repeatable harness** — run Chrome with `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<fixed.wav>` (or a small browser harness feeding a controlled `MediaStream`), record the `_vadAnalyser` RMS sample series on the *same* fixed WAV before vs. after the split, and diff the series — not merely comparing run scores.

## 9. Deploy — Cloudflare Pages

- **Output dir:** `static/`. No build step.
- **`static/_redirects`** — targeted rules only (no catch-all that could mask a missing asset):
  ```
  /static/* /:splat 200
  /player   /player.html 200
  ```
  `/static/*` rewrite lets the existing `/static/...` asset references ([player.html:534-550](../../../static/player.html), [player.js:818](../../../static/player.js)) resolve when `static/` is the root — **no HTML edits and no dev-harness change** (Flask still serves `/static/` locally). A request for a genuinely missing file still 404s (rewrite target doesn't exist).
- **HTTPS:** automatic (required for mic + Web Speech API).
- **CI:** connect the GitHub repo (`WestsideSage/Vocalz`); deploy on push to `main`.

## 10. Error handling

| Condition | Behavior |
|---|---|
| Unparseable / non-YouTube URL | inline message; offer the "Search on YouTube ↗" link |
| oEmbed fails / private video | fall back to manual title/artist via the existing retry UI |
| No synced lyrics found | `lyricsError` → existing "correct title/artist" retry ([index.html:140](../../../static/index.html)) |
| Embed disabled (101/150) | existing [ADR-0002](../../adr/0002-any-song-client-side-youtube-iframe.md) fallback (playback-gate) |
| Invalid/expired BYO-key | surface OpenAI 401, drop to the free lane — never hard-fail the game |
| Non-Chrome / no `SpeechRecognition` / mobile UA | desktop-Chrome interstitial |

## 11. Testing

- **`.cjs` unit tests** for `lyrics-client`, `youtube-meta`, `song-loader`, `key-store` (inject `fetch`).
- **Golden parity** for `lyrics-client`: prove the JS *algorithm* matches [lyrics.py](../../../lyrics.py) on **identical inputs**, including with-duration cases, by reusing/porting its fixtures **plus** added fixtures for durationless / oEmbed-shaped inputs. This asserts algorithm parity, **not** that production picks identical results to the old yt-dlp path (inputs differ — no duration, no explicit-artist tag).
- **Python suite stays green** (still covers the dev harness).
- **Manual real-Chrome smoke**, both lanes: (a) **no key** → browser-SR + VAD score an honest run, deliberate wrong-lyrics still ~0% (anti-cheese intact via the energy/content gate); (b) **key set** → realtime Track 2 fuses in as today. Plus: local-file upload plays via object URL; `_redirects` resolves `/static/*` and `/player` on the deployed preview.

## 12. Risks / open implementation notes

- **Free-lane (browser-SR-only) scoring quality — THE make-or-break, validate FIRST.** Every honest-run validation to date (93–97% / S) used the **premium `gpt-realtime-whisper`** path; the **free** lane (~99% of demo visitors: browser-SR + VAD, no key) has **not** been validated for scoring honesty/feel. It is uniquely uncertain because (a) [ADR-0001](../../adr/0001-tiered-recognizer-byo-key-deploy.md) notes browser SR *"rarely fires `final` during continuous singing"* — sustained singing/melisma is its worst case — and (b) the frozen scoring thresholds were tuned against whisper-quality ASR, so sparser browser-SR input could make honest singing under-score. **First executable step of the plan:** a small browser-SR-only validation **matrix**, not a single run — (a) a fast/dense song, (b) a slow song, (c) wrong-lyrics/silence (anti-cheese must still score ~0), and (d) one normal-song replay — confirming honest singing scores honestly and *feels* good across them. If it doesn't, free-lane reconciliation/threshold tuning — not the migration — is the real work, and we want to know that *before* writing four modules. (This is the assumption the entire free-demo thesis rests on.)
- **`_redirects` rewrite — spike on a real Cloudflare preview, day-one.** `/static/* /:splat 200` is the one deploy-critical assumption left (does an existing-asset lookup pre-empt the rewrite? rewrite vs. redirect semantics?). De-risk it with a throwaway preview deploy the way the IFrame clock was spiked. Fallback if it misbehaves: edit the ~16 `/static/` asset refs to root-relative + add one Flask dev route.
- **VAD parity:** §8 must keep the free lane's energy/VAD behavior bit-for-bit; use the concrete energy-signal diff described in §8 (not just score comparison) before any flag-flip.
- **oEmbed coverage:** some videos (age-restricted/private) return no oEmbed; the manual-title/artist retry is the safety net.
- **BYO-key real-key smoke:** CORS is verified for both `/v1/realtime/client_secrets` (mint) and `/v1/realtime/calls` (connect), but BYO-key is **not "proven" until a real-key smoke passes**: with a real user key, mint a client-secret, open a `/v1/realtime/calls` session, and confirm a transcript streams. Also confirm the exact client-secret request body for `gpt-realtime-whisper` against current OpenAI docs (Context7) — the payload moves client-side from [app.py:148](../../../app.py).
- **Arcade default flip** interacts with the standing sing-test gate ([[arcade-scoring-status]] / [ADR-0003](../../adr/0003-arcade-default-lyric-axis-frozen.md)): the gate is a documented limitation for the demo, not a blocker.

### Implementation sequencing (carry into the plan)
"Everything" is the *scope*, not one monolithic plan. Order to front-load risk and reach a live checkpoint before polish:
1. **Day-one de-risk:** validate free-lane scoring (risk #1) + spike `_redirects` on a Cloudflare preview — *before* building modules.
2. **Core:** the four browser modules + the recognizer mic/VAD split + a **real Cloudflare deploy**.
3. **Validate live** on the deployed preview (free lane + anti-cheese + local upload).
4. **Polish:** desktop-Chrome interstitial, score share-image, BYO-key lane.

This front-loads the two riskiest pieces (the player.js surgery and a real deploy) and yields a shareable link to react to before the polish work.

## 13. External code-review incorporated (2026-06-06)

**First round** — seven critiques verified against the code and folded in: (1) `/static/*` asset 404 → `_redirects` rewrite §9; (2) mic/VAD split from premium Track 2 §8; (3) recognizer mode from `key-store`, not server status §5/§8; (4) local upload handling §7; (5) parity claim tightened to algorithm-parity + durationless fixtures §11; (6) BYO-key copy "stored in this browser and sent only to OpenAI — never to Karaokee" §10/UI; (7) targeted redirects only, no catch-all §9.

**Second round** — five further findings folded in: [P1] an object URL in `sessionStorage` is not a durable cross-page transport → local upload is **dev-only for v1** (§7), superseding first-round #4; [P1] "exact parity" goal reworded to **browser-SR + VAD inputs + product-feel** validation (§3); [P2] CORS proof now names the **exact** endpoints (`/v1/realtime/client_secrets` + `/v1/realtime/calls`, the latter re-probed green) and adds a **real-key smoke** gate (§1/§12); [P2] concrete **VAD-parity harness** via Chrome fake-audio-capture (§8); [P3] free-lane validation expanded to a small **matrix** (§12).
