import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { LrcLine } from '../parser/parseLrc';

export interface LyricsViewProps {
  lines: LrcLine[];
  currentIndex: number;
  className?: string;
  lineClassName?: string;
  activeClassName?: string;
  autoScroll?: boolean;
}

/**
 * Basic lyric list with a highlighted active line and smooth auto-scroll.
 * Tailor the CSS classes in your app; the defaults make the component usable without custom styles.
 */
export function LyricsView({
  lines,
  currentIndex,
  className,
  lineClassName,
  activeClassName,
  autoScroll = true,
}: LyricsViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeLineRef = useRef<HTMLDivElement | null>(null);

  const assignActiveRef = useCallback((node: HTMLDivElement | null) => {
    activeLineRef.current = node;
  }, []);

  useEffect(() => {
    if (!autoScroll) {
      return undefined;
    }

    const target = activeLineRef.current;
    const container = containerRef.current;

    if (!target || !container) {
      return undefined;
    }

    if (typeof IntersectionObserver === 'undefined') {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      },
      {
        root: container,
        threshold: 0.6,
      },
    );

    observer.observe(target);

    return () => {
      observer.disconnect();
    };
  }, [currentIndex, autoScroll]);

  const renderedLines = useMemo(() => {
    if (!lines.length) {
      return (
        <div className="lyrics-view__placeholder">Load lyrics to get started.</div>
      );
    }

    return lines.map((line, index) => {
      const isActive = index === currentIndex;

      return (
        <div
          key={`${line.timeMs}-${index}`}
          ref={isActive ? assignActiveRef : undefined}
          className={`lyrics-view__line ${lineClassName ?? ''} ${
            isActive ? `lyrics-view__line--active ${activeClassName ?? ''}` : ''
          }`}
          data-time={line.timeMs}
        >
          <span className="lyrics-view__timestamp">
            {new Date(line.timeMs).toISOString().substring(14, 19)}
          </span>
          <span className="lyrics-view__text">{line.text}</span>
        </div>
      );
    });
  }, [lines, currentIndex, assignActiveRef, lineClassName, activeClassName]);

  return (
    <div
      ref={containerRef}
      className={`lyrics-view ${className ?? ''}`}
      style={{
        position: 'relative',
        overflowY: 'auto',
        padding: '1rem',
        height: '100%',
        fontFamily: 'Inter, system-ui, sans-serif',
        background: 'rgba(0, 0, 0, 0.65)',
        color: '#fff',
      }}
    >
      {renderedLines}
    </div>
  );
}

export default LyricsView;