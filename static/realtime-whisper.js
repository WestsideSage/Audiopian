(function(root) {
    function buildCommitEvent() {
        return { type: 'input_audio_buffer.commit' };
    }

    function modelSupportsPrompt(model) {
        return model !== 'gpt-realtime-whisper';
    }

    function buildSessionUpdateEvent(options) {
        options = options || {};
        var transcription = {
            model: options.model || 'gpt-realtime-whisper',
            language: options.language || 'en',
        };
        if (options.prompt && modelSupportsPrompt(transcription.model)) transcription.prompt = options.prompt;

        var input = {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: transcription,
        };
        if (transcription.model !== 'gpt-realtime-whisper') {
            input.turn_detection = {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
            };
        }

        return {
            type: 'session.update',
            session: {
                type: 'transcription',
                audio: {
                    input: input,
                },
                include: ['item.input_audio_transcription.logprobs'],
            },
        };
    }

    // Body for POST /v1/realtime/client_secrets — the BYO-key browser-side mint of
    // an ephemeral transcription token. Reuses buildSessionUpdateEvent's session
    // config (model/prompt/turn_detection rules) and wraps it with expires_after,
    // mirroring the server payload in app.py _create_openai_realtime_transcription_session.
    function buildClientSecretBody(options) {
        options = options || {};
        var model = options.model || 'gpt-realtime-whisper';
        var session = buildSessionUpdateEvent(options).session;
        // gpt-realtime-whisper latency/accuracy knob (app.py adds it on this model only).
        if (options.delay && model === 'gpt-realtime-whisper') {
            session.audio.input.transcription.delay = options.delay;
        }
        return {
            expires_after: { anchor: 'created_at', seconds: options.expiresSeconds || 600 },
            session: session,
        };
    }

    function extractClientSecret(session) {
        var value = session && (session.value || (session.client_secret && session.client_secret.value));
        if (!value) throw new Error('Realtime transcription session is missing client_secret.value or value');
        return value;
    }

    var api = {
        buildCommitEvent: buildCommitEvent,
        buildSessionUpdateEvent: buildSessionUpdateEvent,
        buildClientSecretBody: buildClientSecretBody,
        modelSupportsPrompt: modelSupportsPrompt,
        extractClientSecret: extractClientSecret,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.KaraokeeRealtimeWhisper = api;
})(typeof window !== 'undefined' ? window : globalThis);
