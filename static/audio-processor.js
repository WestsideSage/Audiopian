/**
 * AudioWorklet processor that accumulates Float32 mic samples and emits
 * a 2-second chunk (32000 samples at 16kHz) to the main thread each time
 * the buffer fills. Also posts RMS energy level every ~100ms (1600 samples)
 * for voice activity detection.
 */
class ChunkProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._buf = [];
        this._target = 32000; // 2 seconds at 16 000 Hz
        this._energyBuf = [];
        this._energyTarget = 1600; // ~100ms at 16kHz
    }

    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (!channel) return true;

        for (let i = 0; i < channel.length; i++) {
            this._buf.push(channel[i]);
            this._energyBuf.push(channel[i]);
        }

        // Post energy level every ~100ms for voice activity detection
        if (this._energyBuf.length >= this._energyTarget) {
            const samples = this._energyBuf.splice(0, this._energyTarget);
            let sumSq = 0;
            for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
            const rms = Math.sqrt(sumSq / samples.length);
            this.port.postMessage({ type: 'energy', rms: rms });
        }

        // Post audio chunk every 2 seconds for Whisper transcription
        if (this._buf.length >= this._target) {
            const chunk = new Float32Array(this._buf.splice(0, this._target));
            this.port.postMessage({ type: 'chunk', data: chunk });
        }

        return true; // keep processor alive
    }
}

registerProcessor('chunk-processor', ChunkProcessor);
