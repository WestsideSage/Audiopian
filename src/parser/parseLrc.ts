export interface LrcMetadata {
  title?: string;
  artist?: string;
  album?: string;
  lyricsBy?: string;
  offset?: number;
  [key: string]: string | number | undefined;
}

export interface LrcLine {
  timeMs: number;
  text: string;
  lineNumber: number;
}

export interface ParsedLrc {
  metadata: LrcMetadata;
  lines: LrcLine[];
}

export class LrcParseError extends Error {
  constructor(message: string, public readonly line?: number) {
    super(line ? `${message} (line ${line})` : message);
    this.name = 'LrcParseError';
  }
}

const TIMESTAMP_REGEX = /\[(\d{1,2}):(\d{2})(?:\.([0-9]{1,3}))?\]/g;
const META_LINE_REGEX = /^\[(.+?):(.*)\]$/;

const METADATA_KEY_MAP: Record<string, keyof LrcMetadata> = {
  ti: 'title',
  ar: 'artist',
  al: 'album',
  by: 'lyricsBy',
  offset: 'offset',
};

function toMilliseconds(
  minutes: string,
  seconds: string,
  fractions: string | undefined,
  lineNumber: number,
): number {
  const min = Number(minutes);
  const sec = Number(seconds);

  if (!Number.isFinite(min) || !Number.isFinite(sec)) {
    throw new LrcParseError('Invalid timestamp values', lineNumber);
  }

  if (min < 0 || sec < 0 || sec >= 60) {
    throw new LrcParseError('Timestamp out of range', lineNumber);
  }

  const fractionValue = fractions
    ? Number(fractions.padEnd(3, '0').slice(0, 3))
    : 0;

  if (!Number.isFinite(fractionValue)) {
    throw new LrcParseError('Invalid millisecond precision', lineNumber);
  }

  return min * 60 * 1000 + sec * 1000 + fractionValue;
}

function normalizeOffset(value: string, lineNumber: number): number {
  const parsed = Number(value.trim());

  if (!Number.isFinite(parsed)) {
    throw new LrcParseError('Invalid offset metadata value', lineNumber);
  }

  return parsed;
}

export function parseLrc(raw: string): ParsedLrc {
  if (!raw || !raw.trim()) {
    throw new LrcParseError('LRC content is empty');
  }

  const normalized = raw.replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n');
  const rows = normalized.split('\n');
  const metadata: LrcMetadata = {};
  const lines: LrcLine[] = [];

  rows.forEach((row, index) => {
    const lineNumber = index + 1;
    const trimmed = row.trim();

    if (!trimmed) {
      return;
    }

    const timeTags = Array.from(trimmed.matchAll(TIMESTAMP_REGEX));

    if (timeTags.length === 0) {
      const metaMatch = trimmed.match(META_LINE_REGEX);

      if (metaMatch) {
        const [, key, value] = metaMatch;
        const normalizedKey = key.trim().toLowerCase();

        if (normalizedKey === 'offset') {
          metadata.offset = normalizeOffset(value, lineNumber);
        } else {
          const mappedKey = METADATA_KEY_MAP[normalizedKey] ?? normalizedKey;
          metadata[mappedKey] = value.trim();
        }
      }

      return;
    }

    const lyricText = trimmed.replace(TIMESTAMP_REGEX, '').trim();

    timeTags.forEach((tag) => {
      const [, min = '0', sec = '0', fraction] = tag;
      const timeMs = toMilliseconds(min, sec, fraction, lineNumber);

      lines.push({
        timeMs,
        text: lyricText,
        lineNumber,
      });
    });
  });

  if (lines.length === 0) {
    throw new LrcParseError('No time-tagged lyric lines found');
  }

  lines.sort((a, b) => a.timeMs - b.timeMs);

  const offset = typeof metadata.offset === 'number' ? metadata.offset : 0;

  if (offset !== 0) {
    lines.forEach((line) => {
      line.timeMs = Math.max(0, line.timeMs + offset);
    });
  }

  const seenTimestamps = new Set<number>();

  for (const line of lines) {
    if (line.text.length === 0) {
      throw new LrcParseError('Timed lyric line is missing text', line.lineNumber);
    }

    if (seenTimestamps.has(line.timeMs)) {
      throw new LrcParseError('Duplicate timestamp detected', line.lineNumber);
    }

    seenTimestamps.add(line.timeMs);
  }

  return {
    metadata,
    lines,
  };
}