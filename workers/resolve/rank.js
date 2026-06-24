// Pure ranking for resolved YouTube candidates. CommonJS so the .cjs test can
// require() it; wrangler/esbuild bundles it into the ES-module Worker fine.
var JUNK = /\b(live|remix|sped\s*up|nightcore|cover|instrumental|karaoke|8d|reverb|slowed|loop|1\s*hour|one\s*hour|reaction|tutorial)\b/i;

function parseIsoDuration(iso) {
    var m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(String(iso || ''));
    if (!m) return 0;
    return (parseInt(m[1] || 0, 10) * 3600) + (parseInt(m[2] || 0, 10) * 60) + parseInt(m[3] || 0, 10);
}

function scoreCandidate(c, target) {
    var score = 0;
    var dur = c.durationSec || 0;
    var want = target.durationSec || 0;
    if (want && dur) {
        var diff = Math.abs(dur - want);
        if (diff <= 3) score += 50;
        else if (diff <= 8) score += 35;
        else if (diff <= 20) score += 15;
        else score -= Math.min(40, diff); // far-off lengths (loops, edits) sink hard
    }
    var ch = String(c.channelTitle || '');
    if (/-\s*topic$/i.test(ch)) score += 25;
    else if (/vevo$/i.test(ch)) score += 20;
    else if (target.artist && ch.toLowerCase().indexOf(String(target.artist).toLowerCase()) !== -1) score += 15;

    // Penalize junk in the title UNLESS the user's target itself asked for it.
    if (JUNK.test(c.title || '') && !JUNK.test(target.title || '')) score -= 30;
    return score;
}

function rankCandidates(candidates, target) {
    var arr = (candidates || []).map(function (c) {
        return Object.assign({}, c, { _score: scoreCandidate(c, target) });
    });
    arr.sort(function (a, b) { return b._score - a._score; });
    return arr;
}

module.exports = { rankCandidates: rankCandidates, scoreCandidate: scoreCandidate, parseIsoDuration: parseIsoDuration };
