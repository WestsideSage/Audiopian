import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LrcLine } from '../parser/parseLrc';

export interface UseLyricSyncOptions {
  lines: LrcLine[];
  audio?: HTMLAudioElement | null;
  /**
   * Provide a manual playback time (in milliseconds) when not wiring a native audio element.
   */
  currentTimeMs?: number;
  /** Number of lyric lines before/after the active one to expose for rendering. */
  overscan?: number;
}

export interface UseLyricSyncResult {
  currentLine: LrcLine | null;
  nextLine: LrcLine | null;
  previousLine: LrcLine | null;
  currentIndex: number;
  /**
   * Normalized progress between the current and next line.
   * Useful for progress bars or gradient fills.
   */
  progress: number;
  window: LrcLine[];
  /** Seek to an arbitrary lyric index and optionally sync the attached audio element. */
  seekToLine: (index: number) => void;
  /** Binary search helper; returns -1 if the playback position precedes the first line. */
  findIndexForTime: (timeMs: number) => number;
}

const DEFAULT_OVERSCAN = 4;

export function useLyricSync({
  lines,
  audio,
  currentTimeMs,
  overscan = DEFAULT_OVERSCAN,
}: UseLyricSyncOptions): UseLyricSyncResult {
  const sortedLines = useMemo(() => {
    return [...lines].sort((a, b) => a.timeMs - b.timeMs);
  }, [lines]);

  const [internalTimeMs, setInternalTimeMs] = useState<number>(() => {
    if (typeof currentTimeMs === 'number') {
      return currentTimeMs;
    }

    if (audio) {
      return audio.currentTime * 1000;
    }

    return 0;
  });

  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!audio) {
      return undefined;
    }

    const stopLoop = () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    const syncOnce = () => setInternalTimeMs(audio.currentTime * 1000);

    const loop = () => {
      syncOnce();
      if (!audio.paused) {
        rafRef.current = requestAnimationFrame(loop);
      }
    };

    const handlePlay = () => {
      stopLoop();
      rafRef.current = requestAnimationFrame(loop);
    };

    const handlePause = () => {
      stopLoop();
      syncOnce();
    };

    const handleSeek = () => {
      stopLoop();
      syncOnce();
      if (!audio.paused) {
        rafRef.current = requestAnimationFrame(loop);
      }
    };

    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('seeking', handleSeek);
    audio.addEventListener('seeked', handleSeek);
    audio.addEventListener('timeupdate', syncOnce);

    if (!audio.paused) {
      handlePlay();
    } else {
      syncOnce();
    }

    return () => {
      stopLoop();
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('seeking', handleSeek);
      audio.removeEventListener('seeked', handleSeek);
      audio.removeEventListener('timeupdate', syncOnce);
    };
  }, [audio]);

  const playbackTimeMs = typeof currentTimeMs === 'number' ? currentTimeMs : internalTimeMs;

  const findIndexForTime = useCallback(
    (timeMs: number): number => {
      if (!sortedLines.length) {
        return -1;
      }

      if (timeMs < sortedLines[0].timeMs) {
        return -1;
      }

      let left = 0;
      let right = sortedLines.length - 1;
      let match = 0;

      // Binary search allows us to locate positions within log2(n) operations
      // which keeps seeking responsive even for very large lyric files.
      while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const midTime = sortedLines[mid].timeMs;

        if (midTime === timeMs) {
          return mid;
        }

        if (midTime < timeMs) {
          match = mid;
          left = mid + 1;
        } else {
          right = mid - 1;
        }
      }

      return match;
    },
    [sortedLines],
  );

  const [currentIndex, setCurrentIndex] = useState<number>(() => findIndexForTime(playbackTimeMs));

  useEffect(() => {
    setCurrentIndex(findIndexForTime(playbackTimeMs));
  }, [findIndexForTime, playbackTimeMs]);

  const currentLine = currentIndex >= 0 ? sortedLines[currentIndex] ?? null : null;
  const previousLine = currentIndex > 0 ? sortedLines[currentIndex - 1] ?? null : null;
  const nextLine = currentIndex >= 0 ? sortedLines[currentIndex + 1] ?? null : sortedLines[0] ?? null;

  const progress = useMemo(() => {
    if (!currentLine) {
      return 0;
    }

    const nextTime = nextLine ? nextLine.timeMs : currentLine.timeMs + 1;
    const span = nextTime - currentLine.timeMs || 1;

    return Math.min(
      1,
      Math.max(0, (playbackTimeMs - currentLine.timeMs) / span),
    );
  }, [currentLine, nextLine, playbackTimeMs]);

  const windowLines = useMemo(() => {
    if (!sortedLines.length) {
      return [];
    }

    const startIndex = Math.max(0, (currentIndex < 0 ? 0 : currentIndex) - overscan);
    const endIndex = Math.min(sortedLines.length, (currentIndex < 0 ? 0 : currentIndex) + overscan + 1);

    return sortedLines.slice(startIndex, endIndex);
  }, [sortedLines, currentIndex, overscan]);

  const seekToLine = useCallback(
    (index: number) => {
      if (!sortedLines.length) {
        return;
      }

      const clampedIndex = Math.max(0, Math.min(sortedLines.length - 1, index));
      const target = sortedLines[clampedIndex];

      if (audio) {
        audio.currentTime = target.timeMs / 1000;
      }

      if (typeof currentTimeMs !== 'number') {
        setInternalTimeMs(target.timeMs);
      }
    },
    [audio, currentTimeMs, sortedLines],
  );

  return {
    currentLine,
    nextLine,
    previousLine,
    currentIndex,
    progress,
    window: windowLines,
    seekToLine,
    findIndexForTime,
  };
}