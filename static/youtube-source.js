/**
 * YouTube IFrame implementation of the playback-source contract (see
 * static/playback-source.js). A clock-precision spike (verdict folded into ADR-0002) proved
 * getCurrentTime() is frame-grained and smoother than <audio>.currentTime, so the
 * clock is player.getCurrentTime() with NO performance.now() interpolation layer.
 */
function ytStateToString(code) {
    switch (code) {
        case 1:  return 'playing';
        case 2:  return 'paused';
        case 3:  return 'buffering';
        case 0:  return 'ended';
        case 5:  return 'cued';
        case -1: return 'unstarted';
        default: return 'unstarted';
    }
}

// YouTube onError 101 and 150 both mean "embedding disabled by the video owner".
function isEmbedDisabledError(code) { return code === 101 || code === 150; }

function YouTubeIframeSource(videoId, containerId, opts) {
    opts = opts || {};
    var YT_ = opts.YT || (typeof window !== 'undefined' ? window.YT : null);
    var ready = [], ended = [], stateCbs = [], errCbs = [];
    var isReady = false;
    function emit(list, arg) { for (var i = 0; i < list.length; i++) list[i](arg); }

    var player = new YT_.Player(containerId, {
        videoId: videoId,
        width: '100%', height: '100%',   // fill #ytplayer-wrap; YT's 640x360 default would overflow + clip
        playerVars: {
            autoplay: 0,            // gesture-initiated play (Task 5); unmuted autoplay is blocked
            controls: 1, playsinline: 1, enablejsapi: 1, rel: 0, modestbranding: 1, fs: 0,
            origin: (typeof location !== 'undefined' ? location.origin : undefined)
        },
        events: {
            onReady: function () { isReady = true; emit(ready); },
            onStateChange: function (e) {
                var s = ytStateToString(e.data);
                emit(stateCbs, s);
                if (s === 'ended') emit(ended);   // ENDED(0) is more reliable than <audio>'s 'ended'
            },
            onError: function (e) { emit(errCbs, e.data); }
        }
    });

    function num(v) { return isFinite(v) ? v : 0; }
    return {
        play: function () { if (player.playVideo) player.playVideo(); },
        pause: function () { if (player.pauseVideo) player.pauseVideo(); },
        seek: function (t) { if (player.seekTo) player.seekTo(t, true); },
        currentTime: function () { return player.getCurrentTime ? num(player.getCurrentTime()) : 0; },
        duration: function () { return player.getDuration ? num(player.getDuration()) : 0; },
        isPaused: function () { return !player.getPlayerState || player.getPlayerState() !== 1; },
        setVolume: function (v) { if (player.setVolume) player.setVolume(Math.round(v * 100)); },
        onReady: function (cb) { if (isReady) cb(); else ready.push(cb); },
        onEnded: function (cb) { ended.push(cb); },
        onState: function (cb) { stateCbs.push(cb); },
        onEmbedError: function (cb) { errCbs.push(cb); },
        destroy: function () { try { if (player.destroy) player.destroy(); } catch (e) {} }
    };
}

/**
 * Load the IFrame API <script> once and resolve when window.YT is ready.
 * Browser-only. Idempotent.
 */
function ensureYouTubeApi() {
    return new Promise(function (resolve) {
        if (window.YT && window.YT.Player) { resolve(window.YT); return; }
        var prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = function () {
            if (typeof prev === 'function') { try { prev(); } catch (e) {} }
            resolve(window.YT);
        };
        if (!document.getElementById('yt-iframe-api')) {
            var tag = document.createElement('script');
            tag.id = 'yt-iframe-api';
            tag.src = 'https://www.youtube.com/iframe_api';
            document.head.appendChild(tag);
        }
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ytStateToString, isEmbedDisabledError, YouTubeIframeSource, ensureYouTubeApi };
}
