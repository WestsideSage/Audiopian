/**
 * Pure formatter for the end-screen share image. No DOM/canvas — turns the final
 * arcade summary + song into the text lines the canvas draws, so the formatting
 * (truncation, missing fields, the DIFF · pts · % stat) is testable in Node.js.
 * The canvas drawing itself lives in player.js (_downloadShareImage).
 *
 * @param {Object} [summary]  { grade, points, percent, difficulty } from the arcade end screen.
 * @param {Object} [songData] { artist, title } (the sessionStorage songData).
 * @returns {{brand:string, grade:string, stat:string, song:string}}
 */
function buildShareCardLines(summary, songData) {
    summary = summary || {};
    songData = songData || {};

    var grade = summary.grade != null ? String(summary.grade) : '';
    var points = (typeof summary.points === 'number' && isFinite(summary.points)) ? summary.points : 0;
    var percent = (typeof summary.percent === 'number' && isFinite(summary.percent)) ? summary.percent : 0;
    var diff = summary.difficulty ? String(summary.difficulty).toUpperCase() : '';

    var artist = songData.artist || '';
    var title = songData.title || '';
    var song = (artist && title) ? (artist + ' — ' + title) : (artist || title || '');

    var stat = points + ' pts · ' + percent + '%';
    if (diff) stat = diff + ' · ' + stat;

    return {
        brand: 'AUDIOPIAN',
        grade: grade,
        stat: stat,
        song: _truncateShareSong(song, 48)
    };
}

function _truncateShareSong(s, max) {
    s = String(s == null ? '' : s);
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)).replace(/\s+$/, '') + '…';
}

// Node.js exports for testing; browser ignores this (function is a <script> global).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildShareCardLines: buildShareCardLines };
}
