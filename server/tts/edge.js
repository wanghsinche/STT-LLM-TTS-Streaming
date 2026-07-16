const { Communicate } = require("edge-tts-universal");

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientTTSFailure(error) {
  return error?.name === "NoAudioReceived" || error?.message === "No audio was received.";
}

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

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.synthesizeOnce(text, { signal, onAudio, attempt });
        return;
      } catch (error) {
        if (signal?.aborted) return;
        if (!isTransientTTSFailure(error) || attempt === MAX_ATTEMPTS) throw error;
        console.warn(`[tts] transient failure attempt=${attempt}/${MAX_ATTEMPTS}: ${error.message || error}`);
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
  }

  async synthesizeOnce(text, { signal, onAudio, attempt }) {
    if (signal?.aborted) return;

    const communicate = new Communicate(text, {
      voice: this.voice,
      rate: this.rate || "+0%",
      connectionTimeout: this.timeoutMs
    });

    console.log(`[tts] stream voice=${this.voice} lang=${inferLang(this.voice)} format=${this.format} attempt=${attempt}`);

    let timeout;
    let stopped = false;
    let abort;
    let audioBytes = 0;
    let firstAudioLogged = false;
    const startedAt = Date.now();
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
          if (!firstAudioLogged) {
            firstAudioLogged = true;
            console.log(`[tts] first audio in ${Date.now() - startedAt}ms`);
          }
          audioBytes += chunk.data.length;
          onAudio(Buffer.from(chunk.data));
        }
      }
    })();

    try {
      await Promise.race([streamPromise, timeoutPromise, abortPromise]);
    } catch (error) {
      if (audioBytes > 0) throw error;
      throw error;
    } finally {
      stopped = true;
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", abort);
    }
  }
}

module.exports = { EdgeTTS };
