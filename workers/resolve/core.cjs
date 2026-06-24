const { rankCandidates, parseIsoDuration } = require('./rank.js');

var YT_SEARCH = 'https://www.googleapis.com/youtube/v3/search';
var YT_VIDEOS = 'https://www.googleapis.com/youtube/v3/videos';

// fetch + apiKey injected via deps so this is unit-testable with no network.
async function resolveVideos(params, deps) {
    var artist = String(params.artist || '').trim();
    var title = String(params.title || '').trim();
    var durationSec = parseInt(params.duration || 0, 10) || 0;
    if (!artist && !title) return [];

    var doFetch = deps.fetch;
    var key = deps.apiKey;
    var q = (artist + ' ' + title).trim();

    var searchUrl = YT_SEARCH + '?part=snippet&type=video&videoEmbeddable=true&maxResults=8'
        + '&q=' + encodeURIComponent(q) + '&key=' + encodeURIComponent(key);
    var sResp = await doFetch(searchUrl);
    if (!sResp.ok) return [];
    var sData = await sResp.json();
    var items = (sData && sData.items) || [];
    var bald = items
        .filter(function (it) { return it && it.id && it.id.videoId; })
        .map(function (it) {
            return {
                videoId: it.id.videoId,
                title: (it.snippet && it.snippet.title) || '',
                channelTitle: (it.snippet && it.snippet.channelTitle) || '',
                thumbnail: (it.snippet && it.snippet.thumbnails && it.snippet.thumbnails.medium && it.snippet.thumbnails.medium.url) || '',
            };
        });
    if (!bald.length) return [];

    var ids = bald.map(function (c) { return c.videoId; }).join(',');
    var vUrl = YT_VIDEOS + '?part=contentDetails&id=' + encodeURIComponent(ids) + '&key=' + encodeURIComponent(key);
    var vResp = await doFetch(vUrl);
    if (vResp.ok) {
        var vData = await vResp.json();
        var byId = {};
        ((vData && vData.items) || []).forEach(function (v) {
            byId[v.id] = parseIsoDuration(v.contentDetails && v.contentDetails.duration);
        });
        bald.forEach(function (c) { c.durationSec = byId[c.videoId] || 0; });
    }

    var ranked = rankCandidates(bald, { artist: artist, title: title, durationSec: durationSec });
    return ranked.slice(0, 3).map(function (c) {
        return { videoId: c.videoId, title: c.title, channelTitle: c.channelTitle, durationSec: c.durationSec || 0, thumbnail: c.thumbnail || '' };
    });
}

module.exports = { resolveVideos: resolveVideos };
