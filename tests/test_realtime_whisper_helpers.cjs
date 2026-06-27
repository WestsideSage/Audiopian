const assert = require('assert');
const realtime = require('../static/realtime-whisper.js');

function testBuildSessionUpdateEvent() {
  const event = realtime.buildSessionUpdateEvent({
    model: 'gpt-realtime-whisper',
    prompt: 'lyrics vocabulary',
  });

  assert.deepStrictEqual(event, {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: {
            model: 'gpt-realtime-whisper',
            language: 'en',
          },
        },
      },
      include: ['item.input_audio_transcription.logprobs'],
    },
  });
}

function testBuildSessionUpdateEventKeepsPromptForSupportedModels() {
  const event = realtime.buildSessionUpdateEvent({
    model: 'gpt-4o-mini-transcribe',
    prompt: 'lyrics vocabulary',
  });

  assert.strictEqual(
    event.session.audio.input.transcription.prompt,
    'lyrics vocabulary'
  );
}

function testExtractClientSecret() {
  assert.strictEqual(
    realtime.extractClientSecret({ client_secret: { value: 'ek_test' } }),
    'ek_test'
  );
  assert.strictEqual(
    realtime.extractClientSecret({ value: 'ek_direct' }),
    'ek_direct'
  );
  assert.throws(() => realtime.extractClientSecret({}), /client_secret/);
}

// buildClientSecretBody: the POST /v1/realtime/client_secrets body for the
// BYO-key browser-side mint. Mirrors app.py _create_openai_realtime_transcription_session.
function testBuildClientSecretBodyWhisper() {
  const body = realtime.buildClientSecretBody({ model: 'gpt-realtime-whisper', language: 'en' });
  assert.deepStrictEqual(body, {
    expires_after: { anchor: 'created_at', seconds: 600 },
    session: {
      type: 'transcription',
      audio: { input: {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription: { model: 'gpt-realtime-whisper', language: 'en' },
      } },
      include: ['item.input_audio_transcription.logprobs'],
    },
  });
}

function testBuildClientSecretBodyDefaults() {
  const body = realtime.buildClientSecretBody();
  assert.strictEqual(body.session.audio.input.transcription.model, 'gpt-realtime-whisper');
  assert.strictEqual(body.session.audio.input.transcription.language, 'en');
  assert.strictEqual(body.expires_after.seconds, 600);
  assert.strictEqual(body.session.audio.input.transcription.prompt, undefined, 'whisper -> no prompt');
  assert.strictEqual(body.session.audio.input.turn_detection, undefined, 'whisper -> no turn_detection');
}

function testBuildClientSecretBodyNonWhisperAddsPromptAndTurnDetection() {
  const body = realtime.buildClientSecretBody({ model: 'gpt-4o-mini-transcribe', prompt: 'lyrics vocab', expiresSeconds: 120 });
  assert.strictEqual(body.session.audio.input.transcription.prompt, 'lyrics vocab');
  assert.deepStrictEqual(body.session.audio.input.turn_detection, {
    type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500,
  });
  assert.strictEqual(body.expires_after.seconds, 120, 'expiresSeconds override honored');
}

function testBuildClientSecretBodyWhisperIgnoresPromptKeepsDelay() {
  const body = realtime.buildClientSecretBody({ model: 'gpt-realtime-whisper', prompt: 'ignored', delay: 'low' });
  assert.strictEqual(body.session.audio.input.transcription.prompt, undefined, 'whisper ignores prompt');
  assert.strictEqual(body.session.audio.input.transcription.delay, 'low', 'whisper keeps the delay knob');
}

testBuildSessionUpdateEvent();
testBuildSessionUpdateEventKeepsPromptForSupportedModels();
testExtractClientSecret();
testBuildClientSecretBodyWhisper();
testBuildClientSecretBodyDefaults();
testBuildClientSecretBodyNonWhisperAddsPromptAndTurnDetection();
testBuildClientSecretBodyWhisperIgnoresPromptKeepsDelay();
console.log('realtime whisper helper tests passed');
