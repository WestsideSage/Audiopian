(function(root) {
    function clampSample(sample) {
        if (!Number.isFinite(sample)) return 0;
        if (sample < -1) return -1;
        if (sample > 1) return 1;
        return sample;
    }

    function float32ToPcm16Base64(float32) {
        var bytes = new Uint8Array(float32.length * 2);
        for (var i = 0; i < float32.length; i++) {
            var sample = clampSample(float32[i]);
            var value = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
            var intSample = Math.round(value);
            bytes[i * 2] = intSample & 0xff;
            bytes[i * 2 + 1] = (intSample >> 8) & 0xff;
        }

        if (typeof Buffer !== 'undefined') {
            return Buffer.from(bytes).toString('base64');
        }

        var binary = '';
        var chunkSize = 0x8000;
        for (var start = 0; start < bytes.length; start += chunkSize) {
            var chunk = bytes.subarray(start, start + chunkSize);
            binary += String.fromCharCode.apply(null, chunk);
        }
        return btoa(binary);
    }

    function buildAppendAudioEvent(base64Audio) {
        return {
            type: 'input_audio_buffer.append',
            audio: base64Audio,
        };
    }

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

    function extractClientSecret(session) {
        var value = session && (session.value || (session.client_secret && session.client_secret.value));
        if (!value) throw new Error('Realtime transcription session is missing client_secret.value or value');
        return value;
    }

    var api = {
        float32ToPcm16Base64: float32ToPcm16Base64,
        buildAppendAudioEvent: buildAppendAudioEvent,
        buildCommitEvent: buildCommitEvent,
        buildSessionUpdateEvent: buildSessionUpdateEvent,
        modelSupportsPrompt: modelSupportsPrompt,
        extractClientSecret: extractClientSecret,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.KaraokeeRealtimeWhisper = api;
})(typeof window !== 'undefined' ? window : globalThis);
