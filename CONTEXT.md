# Audiopian

The domain language of Audiopian's game mode — how sung audio becomes a score. Created during the architecture sprint when the **Scoring Session** seam was named; extend it lazily as terms get sharpened (see `docs/agents/domain.md`).

## Language

### Run & scoring

**Run**:
One play-through of a song in game mode, from start to end screen.
_Avoid_: session (ambiguous with the realtime transcription session), game.

**Scoring Session**:
The per-**Run** state machine that consumes recognized speech and mic energy and produces line scores, phrase commits, and the **Honest %** — DOM-free, clock passed in, emitting render-intent events.
_Avoid_: scorer, game loop, controller.

**Line**:
A single time-stamped LRC lyric line.

**Phrase**:
The phrase engine's unit of settle/commit, tied to a **Line** and the **Anchors** it requires.
_Avoid_: section, bar.

**Anchor**:
A key word a **Phrase** requires for credit (`anchorsRequired` of them must be **Hit**).
_Avoid_: target. Note: the UI labels these "key words" — same concept.

**Hit**:
An **Anchor** matched by recognized speech.

**Honest %**:
The so-far lyric-coverage percentage over the **Anchors** of phrases already past their end.
_Avoid_: accuracy, score (the **Arcade** has a separate score).

**Reconciliation**:
Crediting late or batched recognition to the **Line** it was actually sung on, after that line has ended.
_Avoid_: catch-up, backfill.

### Recognition & matching

**Word source**:
The provenance tag of a matched word — `vad`, `browser_sr`, or `whisper`.
_Avoid_: origin, channel.

**Energy gate (VAD)**:
The voice-activity condition that must hold for optimistic (edit-distance-only) matches to count. Voice activity is detected primarily by a neural VAD; a simpler microphone-energy gate is the fallback.
_Avoid_: silence detection.

**Hot word**:
The lyric word whose predicted time window contains the current playhead.
_Avoid_: current word.

**Soft boundary**:
The overlap zone in which the outgoing line (`prevLine`) stays matchable while the next line is already active.
_Avoid_: crossfade.

### Arcade

**Arcade**:
The points / combo / grade layer over honest scoring — now the only scoring path (the legacy V1 scorer and its `karaokee_v2` flag / `V` toggle were retired 2026-06-08).
_Avoid_: score mode.

**Commit**:
The one-time event when a **Phrase** first reaches `settled` and **Arcade** points are awarded.
_Avoid_: finalize, lock.

## Relationships

- A **Run** scores many **Lines**; a **Phrase** is tied to a **Line** and requires N **Anchors**.
- **Hits** on **Anchors** drive both the **Honest %** and the **Arcade** **Commit**.
- The **Energy gate** and **Word source** condition whether a spoken word counts as a **Hit**.
- The **Scoring Session** owns the **Run**, drives **Reconciliation**, and emits events the controller renders.
- **Honest %** and **Arcade** diverge by design: **Reconciliation** lifts the **Honest %** but never the already-awarded live **Arcade** multiplier ("blessed divergence").

## Example dialogue

> **Dev:** "When the browser batches three lines into one late `final`, does the **Arcade** multiplier retro-update?"
> **Domain expert:** "No — **Reconciliation** credits those **Anchors** to the **Lines** they were sung on and lifts the **Honest %**, but the **Commit** already happened, so the multiplier stays. Blessed divergence."

## Flagged ambiguities

- **"key word" (UI) vs Anchor (engine)** — same concept; the glossary term is **Anchor**, the on-screen label is "key word".
- **"session"** — disambiguate the **Scoring Session** / **Run** (gameplay scoring) from the OpenAI realtime *transcription session* minted by `/realtime-transcription-session`.
