/**
 * Orchestrates a paste-a-URL load entirely in the browser: youtube-meta (oEmbed)
 * then lyrics-client (lrclib), returning the exact songData shape index.html
 * writes to sessionStorage. deps.{meta,lyrics,fetch} injectable for tests;
 * defaults to the window.Karaokee* globals.
 */
async function loadFromUrl(url, deps) {
    deps = deps || {};
    var meta = deps.meta || (typeof window !== 'undefined' && window.KaraokeeYouTubeMeta);
    var lyricsClient = deps.lyrics || (typeof window !== 'undefined' && window.KaraokeeLyricsClient);
    if (!meta || !lyricsClient) throw new Error('song-loader requires youtube-meta and lyrics-client');

    var info = await meta.fetchMeta(url, deps);
    var lyrics = await lyricsClient.fetchLyrics({ title: info.title, artist: info.artist }, deps);
    var songData = { videoId: info.videoId, artist: info.artist, title: info.title, lyrics: lyrics || [] };
    if (!songData.lyrics.length) {
        songData.lyricsError = 'No synced lyrics found for "' + info.artist + ' — ' + info.title +
            '". Correct the title/artist below and retry.';
    }
    return songData;
}

var KaraokeeSongLoader = { loadFromUrl: loadFromUrl };
if (typeof window !== 'undefined') window.KaraokeeSongLoader = KaraokeeSongLoader;
if (typeof module !== 'undefined' && module.exports) module.exports = KaraokeeSongLoader;
