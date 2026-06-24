import core from './core.cjs';

function cors(resp) {
    resp.headers.set('Access-Control-Allow-Origin', '*');
    resp.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return resp;
}

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
        var url = new URL(request.url);
        if (url.pathname !== '/api/resolve') return cors(new Response('Not found', { status: 404 }));

        var params = {
            artist: url.searchParams.get('artist') || '',
            title: url.searchParams.get('title') || '',
            duration: url.searchParams.get('duration') || '0',
        };
        if (!params.artist && !params.title) {
            return cors(Response.json({ error: 'artist or title required' }, { status: 400 }));
        }
        try {
            var candidates = await core.resolveVideos(params, { fetch: fetch, apiKey: env.YOUTUBE_API_KEY });
            return cors(Response.json({ candidates: candidates }));
        } catch (e) {
            return cors(Response.json({ error: 'resolve failed', candidates: [] }, { status: 502 }));
        }
    },
};
