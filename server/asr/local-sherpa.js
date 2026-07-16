const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");
const sherpa = require("sherpa-onnx");

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
  return filePath;
}

function createRecognizer(modelDir) {
  const model = requireFile(path.join(modelDir, "model.int8.onnx"), "ASR model");
  const tokens = requireFile(path.join(modelDir, "tokens.txt"), "ASR tokens");
  return sherpa.createOfflineRecognizer({
    modelConfig: {
      paraformer: { model },
      tokens
    }
  });
}

function createVad(modelDir, sampleRate) {
  const model = requireFile(path.join(modelDir, "silero_vad.onnx"), "VAD model");
  return sherpa.createVad({
    sileroVad: {
      model,
      threshold: 0.5,
      minSpeechDuration: 0.25,
      minSilenceDuration: 0.5,
      speechPad: 0.1,
      maxSpeechDuration: 15,
      windowSize: 512
    },
    sampleRate,
    debug: false,
    numThreads: 1,
    bufferSizeInSeconds: 30
  });
}

function pcm16ToFloat32(buffer) {
  const samples = new Float32Array(buffer.length / 2);
  for (let i = 0; i < samples.length; i += 1) {
    const value = buffer.readInt16LE(i * 2);
    samples[i] = Math.max(-1, Math.min(1, value / 32768));
  }
  return samples;
}

class LocalSherpaASR extends EventEmitter {
  constructor(options) {
    super();
    this.modelDir = options.modelDir;
    this.sampleRate = options.sampleRate || 16000;
    this.recognizer = createRecognizer(this.modelDir);
    this.vad = createVad(this.modelDir, this.sampleRate);
    this.buffer = sherpa.createCircularBuffer(30 * this.sampleRate);
    this.closed = false;
  }

  acceptPcm16(buffer) {
    if (this.closed || !buffer || buffer.length === 0) return;
    const samples = pcm16ToFloat32(buffer);
    const windowSize = this.vad.config.sileroVad.windowSize;
    this.buffer.push(samples);

    while (this.buffer.size() > windowSize) {
      const segmentSamples = this.buffer.get(this.buffer.head(), windowSize);
      this.buffer.pop(windowSize);
      this.vad.acceptWaveform(segmentSamples);
    }

    while (!this.vad.isEmpty()) {
      const segment = this.vad.front();
      this.vad.pop();
      const stream = this.recognizer.createStream();
      stream.acceptWaveform(this.sampleRate, segment.samples);
      this.recognizer.decode(stream);
      const result = this.recognizer.getResult(stream);
      stream.free();

      const text = (result.text || "").trim();
      if (text) {
        this.emit("final", {
          text,
          timestamp: Date.now()
        });
      }
    }
  }

  close() {
    this.closed = true;
    if (this.recognizer) this.recognizer.free();
    if (this.vad) this.vad.free();
  }
}

module.exports = { LocalSherpaASR };
