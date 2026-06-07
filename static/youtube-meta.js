/**
 * Browser-side YouTube metadata: extract videoId from a URL and fetch title/artist
 * via the (CORS-open) YouTube oEmbed endpoint. parseTitleArtist ports
 * downloader.parse_title_artist. fetchMeta takes an injected `fetch`.
 */
function videoIdFromUrl(url) {
    if (!url) return null;
    var s = String(url).trim();
    var m = s.match(/(?:youtu\.be\/)([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    m = s.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    m = s.match(/\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    return null;
}

function parseTitleArtist(title, author) {
    var t = String(title || '');
    // YouTube auto-generated "Topic" channels report author as "Artist - Topic";
    // strip that suffix so the lyrics search gets a clean artist.
    var cleanAuthor = String(author || '').replace(/\s*-\s*topic\s*$/i, '').trim();
    var idx = t.indexOf(' - ');
    if (idx !== -1) return { artist: t.slice(0, idx).trim(), title: t.slice(idx + 3).trim() };
    return { artist: cleanAuthor, title: t.trim() };
}

async function fetchMeta(url, deps) {
    var doFetch = (deps && deps.fetch) || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('fetchMeta requires a fetch implementation');
    var videoId = videoIdFromUrl(url);
    if (!videoId) throw new Error('Not a recognizable YouTube URL');
    var oembedUrl = 'https://www.youtube.com/oembed?url=' +
        encodeURIComponent('https://www.youtube.com/watch?v=' + videoId) + '&format=json';
    var resp = await doFetch(oembedUrl);
    if (!resp.ok) throw new Error('YouTube metadata lookup failed (' + resp.status + ')');
    var data = await resp.json();
    var ta = parseTitleArtist(data.title, data.author_name);
    return { videoId: videoId, artist: ta.artist, title: ta.title };
}

var KaraokeeYouTubeMeta = { videoIdFromUrl: videoIdFromUrl, parseTitleArtist: parseTitleArtist, fetchMeta: fetchMeta };
if (typeof window !== 'undefined') window.KaraokeeYouTubeMeta = KaraokeeYouTubeMeta;
if (typeof module !== 'undefined' && module.exports) module.exports = KaraokeeYouTubeMeta;
