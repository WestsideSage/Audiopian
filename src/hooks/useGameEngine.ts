import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LrcLine } from '../parser/parseLrc';

export type Judgment = 'perfect' | 'great' | 'good' | 'miss';

export interface UseGameEngineOptions {
  cues: LrcLine[];
  audio?: HTMLAudioElement | null;
  windows?: Partial<Record<Exclude<Judgment, 'miss'>, number>> & { miss?: number };
  weights?: Partial<Record<Judgment, number>>;
}

export interface GameState {
  combo: number;
  maxCombo: number;
  score: number;
  processed: number;
  judgments: Record<Judgment, number>;
  accuracy: number;
  lastJudgment?: {
    type: Judgment;
    deltaMs: number;
    index: number;
  };
}

export interface UseGameEngineResult {
  state: GameState;
  nextCue: LrcLine | null;
  registerHit: (timestampMs?: number) => void;
  registerMiss: () => void;
  reset: () => void;
}

const DEFAULT_WINDOWS: Required<UseGameEngineOptions['windows']> = {
  perfect: 80,
  great: 150,
  good: 250,
  miss: 350,
};

const DEFAULT_WEIGHTS: Record<Judgment, number> = {
  perfect: 1,
  great: 0.85,
  good: 0.6,
  miss: 0,
};

const BASE_SCORE = 1000;

const INITIAL_STATE: GameState = {
  combo: 0,
  maxCombo: 0,
  score: 0,
  processed: 0,
  judgments: {
    perfect: 0,
    great: 0,
    good: 0,
    miss: 0,
  },
  accuracy: 0,
};

export function useGameEngine({ cues, audio, windows, weights }: UseGameEngineOptions): UseGameEngineResult {
  const sortedCues = useMemo(() => [...cues].sort((a, b) => a.timeMs - b.timeMs), [cues]);
  const windowsRef = useRef({ ...DEFAULT_WINDOWS, ...windows });
  const weightsRef = useRef({ ...DEFAULT_WEIGHTS, ...weights });

  useEffect(() => {
    windowsRef.current = { ...DEFAULT_WINDOWS, ...windows };
  }, [windows]);

  useEffect(() => {
    weightsRef.current = { ...DEFAULT_WEIGHTS, ...weights };
  }, [weights]);

  const [state, setState] = useState<GameState>(INITIAL_STATE);
  const indexRef = useRef(0);

  useEffect(() => {
    indexRef.current = 0;
    setState(INITIAL_STATE);
  }, [sortedCues]);

  const commitJudgment = useCallback((type: Judgment, deltaMs: number) => {
    setState((prev) => {
      const nextProcessed = prev.processed + 1;
      const nextCombo = type === 'miss' ? 0 : prev.combo + 1;
      const maxCombo = Math.max(prev.maxCombo, nextCombo);
      const nextJudgments = {
        ...prev.judgments,
        [type]: prev.judgments[type] + 1,
      };
      const addedScore = Math.round(BASE_SCORE * (weightsRef.current[type] ?? 0));
      const score = prev.score + addedScore;
      const accuracy = nextProcessed === 0 ? 0 : score / (nextProcessed * BASE_SCORE);

      return {
        combo: nextCombo,
        maxCombo,
        score,
        processed: nextProcessed,
        judgments: nextJudgments,
        accuracy,
        lastJudgment: {
          type,
          deltaMs,
          index: indexRef.current - 1,
        },
      };
    });
  }, []);

  const evaluateTiming = useCallback((deltaAbs: number): Judgment => {
    const windowConfig = windowsRef.current;

    if (deltaAbs <= windowConfig.perfect) {
      return 'perfect';
    }

    if (deltaAbs <= windowConfig.great) {
      return 'great';
    }

    if (deltaAbs <= windowConfig.good) {
      return 'good';
    }

    return 'miss';
  }, []);

  const advanceIndex = useCallback(() => {
    indexRef.current = Math.min(indexRef.current + 1, sortedCues.length);
  }, [sortedCues.length]);

  const registerHit = useCallback(
    (timestampMs?: number) => {
      const cue = sortedCues[indexRef.current];

      if (!cue) {
        return;
      }

      const actualTime = typeof timestampMs === 'number'
        ? timestampMs
        : audio
          ? audio.currentTime * 1000
          : cue.timeMs;

      const deltaMs = actualTime - cue.timeMs;
      const judgment = evaluateTiming(Math.abs(deltaMs));

      advanceIndex();
      commitJudgment(judgment, deltaMs);
    },
    [advanceIndex, audio, commitJudgment, evaluateTiming, sortedCues],
  );

  const registerMiss = useCallback(() => {
    if (!sortedCues[indexRef.current]) {
      return;
    }

    advanceIndex();
    commitJudgment('miss', NaN);
  }, [advanceIndex, commitJudgment, sortedCues]);

  const reset = useCallback(() => {
    indexRef.current = 0;
    setState(INITIAL_STATE);
  }, []);

  useEffect(() => {
    if (!audio) {
      return undefined;
    }

    let rafId: number | null = null;

    const loop = () => {
      const cue = sortedCues[indexRef.current];

      if (!cue) {
        return;
      }

      const missWindow = windowsRef.current.miss ?? windowsRef.current.good;
      const now = audio.currentTime * 1000;

      if (now - cue.timeMs > missWindow) {
        advanceIndex();
        commitJudgment('miss', now - cue.timeMs);
      }

      if (!audio.paused) {
        rafId = requestAnimationFrame(loop);
      }
    };

    if (!audio.paused) {
      rafId = requestAnimationFrame(loop);
    }

    const handlePlay = () => {
      if (rafId === null) {
        rafId = requestAnimationFrame(loop);
      }
    };

    const handlePause = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }

      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
    };
  }, [advanceIndex, audio, commitJudgment, sortedCues]);

  return {
    state,
    nextCue: sortedCues[indexRef.current] ?? null,
    registerHit,
    registerMiss,
    reset,
  };
}
