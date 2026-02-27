/**
 * AudioWorklet processor that accumulates Float32 mic samples and emits
 * a 2-second chunk (32000 samples at 16kHz) to the main thread each time
 * the buffer fills. The main thread encodes the chunk as WAV and POSTs it
 * to /transcribe.
 */
class ChunkProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._buf = [];
        this._target = 32000; // 2 seconds at 16 000 Hz
    }

    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (!channel) return true;

        for (let i = 0; i < channel.length; i++) {
            this._buf.push(channel[i]);
        }

        if (this._buf.length >= this._target) {
            const chunk = new Float32Array(this._buf.splice(0, this._target));
            this.port.postMessage(chunk);
        }

        return true; // keep processor alive
    }
}

registerProcessor('chunk-processor', ChunkProcessor);
