/**
 * Pure detection + removal of NON-LYRIC LRC lines: rap-battle / dialogue
 * SPEAKER LABELS ("Lil'D:", "Shawty e demoni:") and SECTION HEADERS
 * ("[Chorus]", "(Verse 1)"). These are annotations, not sung lyrics, so the
 * scoring engine must never treat them as required lines. Applied at the
 * parseLrc choke point (lyrics-client.js / lyrics.py). No DOM -- Node-testable.
 */
var MAX_SPEAKER_LABEL_WORDS = 4;

// Presence of any of these in a colon-ending line means it is a SENTENCE
// (e.g. "and then she said:"), not a bare speaker tag -> keep it.
var SENTENCE_STOPWORDS = {
    'and': 1, 'then': 1, 'the': 1, 'to': 1, 'of': 1, 'in': 1, 'is': 1, 'are': 1,
    'was': 1, 'were': 1, 'she': 1, 'he': 1, 'we': 1, 'you': 1, 'it': 1, 'that': 1,
    'this': 1, 'but': 1, 'so': 1, 'with': 1, 'my': 1, 'your': 1, 'a': 1, 'i': 1
};

// First inner word of a fully-wrapped line (after dropping a trailing number / "xN").
var SECTION_KEYWORDS = {
    'intro': 1, 'verse': 1, 'chorus': 1, 'prechorus': 1, 'pre-chorus': 1,
    'postchorus': 1, 'post-chorus': 1, 'bridge': 1, 'outro': 1, 'hook': 1,
    'refrain': 1, 'interlude': 1, 'breakdown': 1, 'drop': 1, 'instrumental': 1,
    'solo': 1, 'vamp': 1, 'coda': 1, 'spoken': 1
};

function _words(s) {
    return String(s || '').trim().split(/\s+/).filter(Boolean);
}

function isSpeakerLabel(text) {
    var t = String(text || '').trim();
    if (t.charAt(t.length - 1) !== ':') return false;
    var core = t.slice(0, -1).trim();
    if (!core) return false;
    var words = _words(core);
    if (words.length === 0 || words.length > MAX_SPEAKER_LABEL_WORDS) return false;
    for (var i = 0; i < words.length; i++) {
        var w = words[i].toLowerCase().replace(/[^a-z'-]/g, '');
        if (SENTENCE_STOPWORDS[w]) return false;
    }
    return true;
}

function isSectionHeader(text) {
    var t = String(text || '').trim();
    // entire line is ONE balanced [ ] / ( ) / { } wrap, no inner brackets
    var m = /^[\[({]\s*([^\[\](){}]+?)\s*[\])}]$/.exec(t);
    if (!m) return false;
    var inner = m[1].toLowerCase().trim();
    inner = inner.replace(/[\s-]*(?:x\s*)?\d+\s*x?$/i, '').trim(); // "verse 1" -> "verse"
    var first = inner.split(/\s+/)[0] || inner;
    return !!(SECTION_KEYWORDS[inner] || SECTION_KEYWORDS[first]);
}

function isNonLyricLine(text) {
    return isSpeakerLabel(text) || isSectionHeader(text);
}

function stripNonLyricLines(lines) {
    if (!Array.isArray(lines)) return lines;
    var out = [];
    for (var i = 0; i < lines.length; i++) {
        if (lines[i] && isNonLyricLine(lines[i].text)) continue;
        out.push(lines[i]);
    }
    if (out.length === 0 && lines.length > 0) return lines; // fail-safe: never blank the sheet
    return out;
}

var KaraokeeLyricAnnotations = {
    isSpeakerLabel: isSpeakerLabel,
    isSectionHeader: isSectionHeader,
    isNonLyricLine: isNonLyricLine,
    stripNonLyricLines: stripNonLyricLines,
    MAX_SPEAKER_LABEL_WORDS: MAX_SPEAKER_LABEL_WORDS,
    SENTENCE_STOPWORDS: SENTENCE_STOPWORDS,
    SECTION_KEYWORDS: SECTION_KEYWORDS
};
if (typeof window !== 'undefined') window.KaraokeeLyricAnnotations = KaraokeeLyricAnnotations;
if (typeof module !== 'undefined' && module.exports) module.exports = KaraokeeLyricAnnotations;
