/**
 * Pure title/artist cleanup for the paste-fallback + video-picker ranking.
 * - Splits "Artist - Title" on several dash variants (and prefers that split
 *   over the uploader/channel, fixing the "channel-as-artist" bug).
 * - Removes a DENYLIST of known junk tokens from titles. Never blanket-strips
 *   parentheses, so legitimate titles like "(I Can't Get No) Satisfaction" survive.
 */
var SEPARATORS = [' - ', ' – ', ' — ', ' -', '- ', '–', '—', ' | ', ' : '];

var NOISE_PAREN = /[\(\[]\s*(?:official\s*)?(?:music\s*)?(?:audio|video|lyric|lyrics|lyric video|visualizer|visualiser|hd|hq|4k|explicit|clean|remaster(?:ed)?(?:\s*\d{2,4})?|audio only)\s*[\)\]]/gi;
// Require a separating space before the marker (so a leading "Ft. Lauderdale ..."
// is NOT treated as a feature credit) and a literal "." after ft/feat (so a bare
// word "feat" mid-title is left alone). Anchored to end-of-string.
var NOISE_FEAT = /\s+[\(\[]?\s*(?:ft|feat)\.\s+[^\)\]]*[\)\]]?\s*$/i;

function stripNoise(title) {
    var t = String(title || '');
    t = t.replace(NOISE_PAREN, ' ');
    t = t.replace(NOISE_FEAT, ' ');
    return t.replace(/\s{2,}/g, ' ').trim();
}

function splitArtistTitle(title) {
    var t = String(title || '');
    for (var i = 0; i < SEPARATORS.length; i++) {
        var idx = t.indexOf(SEPARATORS[i]);
        if (idx <= 0) continue;                       // no separator, or it's leading
        var artist = t.slice(0, idx).trim();
        var rest = t.slice(idx + SEPARATORS[i].length).trim();
        if (artist && rest) return { artist: artist, title: rest };  // both halves required
    }
    return null;
}

function cleanChannel(author) {
    return String(author || '').replace(/\s*-\s*topic\s*$/i, '').replace(/\s*vevo\s*$/i, '').trim();
}

function cleanMetadata(rawTitle, rawAuthor) {
    var split = splitArtistTitle(rawTitle);
    if (split) return { artist: split.artist, title: stripNoise(split.title) };
    return { artist: cleanChannel(rawAuthor), title: stripNoise(rawTitle) };
}

var KaraokeeMetadataClean = { cleanMetadata: cleanMetadata, stripNoise: stripNoise, splitArtistTitle: splitArtistTitle, cleanChannel: cleanChannel };
if (typeof window !== 'undefined') window.KaraokeeMetadataClean = KaraokeeMetadataClean;
if (typeof module !== 'undefined' && module.exports) module.exports = KaraokeeMetadataClean;
