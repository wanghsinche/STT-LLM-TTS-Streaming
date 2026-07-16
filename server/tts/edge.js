const { Communicate } = require("edge-tts-universal");

function inferLang(voice) {
  const match = /[a-z]{2}-[A-Z]{2}/.exec(voice || "");
  return match ? match[0] : "zh-CN";
}

class EdgeTTS {
  constructor(config) {
    this.voice = config.voice;
    this.rate = config.rate;
    this.format = config.format || "audio-24khz-48kbitrate-mono-mp3";
    this.timeoutMs = config.timeoutMs || 10000;
    this.tlsRejectUnauthorized = config.tlsRejectUnauthorized !== false;
  }

  async synthesize(text, { signal, onAudio }) {
    if (signal?.aborted) return;
    if (!this.tlsRejectUnauthorized) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      console.warn("[tts] TLS certificate verification is disabled");
    }

    const communicate = new Communicate(text, {
      voice: this.voice,
      rate: this.rate || "+0%",
      connectionTimeout: this.timeoutMs
    });

    console.log(`[tts] stream voice=${this.voice} lang=${inferLang(this.voice)} format=${this.format}`);

    let timeout;
    let stopped = false;
    let abort;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        stopped = true;
        reject(new Error("TTS timed out"));
      }, this.timeoutMs);
    });
    const abortPromise = new Promise((resolve) => {
      abort = () => {
        stopped = true;
        resolve();
      };
      if (signal) signal.addEventListener("abort", abort, { once: true });
    });

    const streamPromise = (async () => {
      for await (const chunk of communicate.stream()) {
        if (stopped || signal?.aborted) return;
        if (chunk.type === "audio" && chunk.data?.length > 0) {
          onAudio(Buffer.from(chunk.data));
        }
      }
    })();

    try {
      await Promise.race([streamPromise, timeoutPromise, abortPromise]);
    } finally {
      stopped = true;
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", abort);
    }
  }
}

module.exports = { EdgeTTS };
