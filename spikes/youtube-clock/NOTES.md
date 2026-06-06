# Spike: YouTube IFrame clock precision (THROWAWAY)

**This is throwaway de-risking code.** Delete it (or fold the verdict into an ADR) once the
question below is answered. It is not part of the app.

## The question

[ADR-0002](../../docs/adr/0002-any-song-client-side-youtube-iframe.md) and
[deployment.md](../../docs/operations/deployment.md) move the backing track from a server-fed
`<audio>` element to the **client-side YouTube IFrame Player API**. The whole scoring clock is
read through one accessor — `_now()` at `static/player.js:1012` — which today returns the
**frame-accurate, synchronous** `audio.currentTime`. The IFrame API only exposes
`getCurrentTime()`, which is **coarse and polled (~4×/sec)**.

> Can `getCurrentTime()` + `performance.now()` interpolation produce a `_now()` clock precise
> and smooth enough to drive scoring on fast rap with tight word windows?

This is the **top engineering risk and a go/no-go gate on ADR-0002's entire near-stateless
architecture.** If the answer is no, we reconsider the audio approach *before* building anything
else. Spike it standalone — **do not touch `player.js`'s timing core to answer it.**

## What it measures

A standalone page embeds the IFrame player, plays muted, and samples at ~60Hz:

- **jump error (the headline):** an interpolated clock re-anchors on every fresh `getCurrentTime()`
  poll. At each re-anchor we record `interpolated_from_previous_anchor − new_truth`. That
  correction *is* the jitter the scoring core would inherit. Reported as abs p50/p95/**p99**/max ms.
- **granularity:** ms between distinct `getCurrentTime()` values — how coarse the raw clock is.
- **drift:** mean per-interval rate ratio (media/perf, want ~1.000), projected over the run.
- **robustness:** backward jumps, forward jumps (ads/seeks), buffering stalls (count/total/worst),
  player errors (101/150 = embedding disabled).

## Pass/fail threshold (derived from `static/sync-helpers.js`)

`getWindowParams()`'s tightest matching-window edge is **0.3s** (slow `windowStart`); fast tempos
get the *widest* windows (−0.5/+2.5s). So a clock error only bites if it is large relative to
~300ms. Bands:

- **GREEN** — p99 jump < 50ms, projected drift < 50ms, no stall > 200ms → negligible vs a 300ms
  window (~3 frames @60fps). Ship the IFrame refactor.
- **YELLOW** — p99 jump < 150ms → usable, but the `performance.now()` smoothing is load-bearing;
  worth a small extra-care pass.
- **RED** — p99 jump ≥ 150ms, unbounded drift, backward jumps, or stalls/ads desyncing by hundreds
  of ms → reconsider the audio approach before committing the refactor.

## How to run

Authoritative environment is **desktop Chrome** (the deployment target). One command:

```bash
python -m http.server 8765 --directory spikes/youtube-clock
# then open:  http://localhost:8765/
#   ?v=<VIDEO_ID>   test a real "- Topic" music upload (default is Google's IFrame-API sample)
#   ?secs=<N>       run length (default 60)
```

Read the live verdict on the page; the full result object is at `window.__SPIKE_RESULT` and is
`console.log`'d as `SPIKE_RESULT {...}`.

## Status / Verdict

**Instrument validated (2026-06-05); real-clock measurement pending in desktop Chrome.**

- The harness was self-tested headless via `?fake=1` (simulated coarse 250ms clock):
  - clean clock → p99 jump **0.1ms**, rate ratio 0.99999 → **GREEN** ✓
  - `&jitter=200` → p99 jump **367ms**, drift 499ms → **RED** ✓
  - So the measurement loop, percentile math, drift projection, and verdict bands are correct.
- **Headless/automated Chromium cannot measure the real clock:** YouTube returns embed error
  **150** and refuses playback for automated browsers (HeadlessChrome UA / `navigator.webdriver`) —
  even for universally-embeddable videos like `jNQXAC9IVRw`. This is an automation limitation, not
  a clock result. The authoritative environment is **real desktop Chrome** (the deployment target).

**Real run (in real desktop Chrome — Chrome/148, `navigator.webdriver`=false):**
```
python -m http.server 8765 --directory 'C:\GPT5-Projects\Karaokee\spikes\youtube-clock'   # PowerShell-quoted path
# open http://localhost:8765/?v=<a real song, e.g. a "- Topic" upload>&secs=60
```

### Real verdict (2026-06-05): provisional GREEN — and the central assumption was wrong

One clean 30s run on `dQw4w9WgXcQ` (the most-embedded music video) — full `window.__SPIKE_RESULT`:

| metric | value | meaning |
|---|---|---|
| **granularity p50** | **16.7ms** (p95 16.9, max 25.1) | `getCurrentTime()` updates **every frame (~60Hz)** — NOT the coarse ~250ms ADR-0002 feared |
| **jump-error p99** | **1.6ms** (p50 0.4, max 2.6) | jitter the scoring clock would inherit — **~200× inside** the 300ms tolerance |
| mean rate ratio | 1.00013 | clock advances at true media rate |
| projected drift | 3.9ms / 30s | negligible |
| backward / forward jumps | 0 / 0 | no glitches |
| stalls / errors | 0 / none | clean playback (no ad fired this run) |

**The premise that `getCurrentTime()` is coarse and polled ~4×/sec is refuted** for modern YouTube
IFrame in desktop Chrome: it returned a frame-grained, near-continuous value (~60Hz).

**Baseline — the same harness vs. a plain `<audio>` element (`?audio=1`), the incumbent `_now()`
source:** p50 0.06ms, **p99 13.7ms, max 130ms**, granularity p50 16.7ms. So the `<audio>` clock the
scorer *already runs on today* is **noisier** than the IFrame (p99 1.6 / max 2.6ms). This matters
two ways: (1) the `<audio>` baseline is hardware-audio-clock-derived (genuinely independent of
`performance.now`), and it shows real divergence — so the metric is **not** a `performance.now`
echo; it captures true clock imperfection. (2) Apples-to-apples, **the IFrame steady-state clock is
equivalent-to-slightly-better than the `<audio>.currentTime` scoring depends on.** Honest caveat:
the IFrame's tight number is partly because `getCurrentTime()` is itself system-clock-interpolated
(so it tracks our re-anchoring closely); the load-bearing conclusion is the *comparison*, not the
absolute — and the comparison says the precision axis is a non-issue.

### What is NOT yet proven (robustness axis — the real run never hit these)

- **Pre-roll / mid-roll ads** — `getCurrentTime()` would reflect the ad timeline or 0 = hard desync.
  No ad fired in the logged-out embed; a logged-in / no-adblock run is the validator.
- **Buffering stalls** and **post-seek re-sync** — zero stalls and no seeks occurred; that's
  *absence of the event*, not proven resilience. (Seek-recovery wasn't tested; a deliberate seek
  would register as a `forwardJump` and needs isolating — a follow-up if we add seek to the player.)
- **Embeddability tax (confirmed real):** 3 of 4 test videos returned **error 150** (embed disabled:
  both VEVO MVs + old uploads). Only the rickroll played. → ADR-0002's "prefer `- Topic` uploads +
  degrade gracefully on a miss" is load-bearing, not optional.

**Decision it drove:** precision gate provisionally GREEN → safe to proceed toward the `_now()` swap
(single seam at `static/player.js:1012`). Before fully committing, do one confirmation run in normal
Chrome on a real `- Topic` song that actually throws an ad, judging on jump-error p99 **and**
stalls/forwardJumps/errors. Then delete this spike or migrate the verdict into ADR-0002.
