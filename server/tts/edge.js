const crypto = require("crypto");
const { EdgeTTS: NodeEdgeTTS } = require("node-edge-tts");

function normalizeRate(rate) {
  if (!rate || rate === "+0%" || rate === "0%") return "default";
  return rate;
}

function inferLang(voice) {
  const match = /[a-z]{2}-[A-Z]{2}/.exec(voice || "");
  return match ? match[0] : "zh-CN";
}

function escapeXml(text) {
  return text.replace(/[<>&"']/g, (char) => {
    switch (char) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case '"': return "&quot;";
      case "'": return "&apos;";
      default: return char;
    }
  });
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

    const client = new NodeEdgeTTS({
      voice: this.voice,
      lang: inferLang(this.voice),
      outputFormat: this.format,
      rate: normalizeRate(this.rate),
      timeout: this.timeoutMs
    });

    console.log(`[tts] connect wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1 voice=${this.voice} format=${this.format}`);
    const ws = await client._connectWebSocket();
    console.log(`[tts] connected, synthesize ${text.length} chars`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => rejectOnce(new Error("TTS timed out")), this.timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        if (signal) signal.removeEventListener("abort", abort);
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
      };
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abort = () => resolveOnce();

      if (signal) signal.addEventListener("abort", abort, { once: true });

      ws.on("message", (data, isBinary) => {
        if (signal?.aborted) return;
        if (isBinary) {
          const separator = "Path:audio\r\n";
          const index = data.indexOf(separator);
          if (index < 0) return;
          const audioData = data.subarray(index + separator.length);
          if (audioData.length > 0) onAudio(Buffer.from(audioData));
          return;
        }

        const message = data.toString();
        if (message.includes("Path:turn.end")) resolveOnce();
      });

      ws.on("error", rejectOnce);
      ws.on("close", () => resolveOnce());

      const requestId = crypto.randomBytes(16).toString("hex");
      ws.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n` +
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${inferLang(this.voice)}">` +
        `<voice name="${this.voice}"><prosody rate="${normalizeRate(this.rate)}" pitch="default" volume="default">${escapeXml(text)}</prosody></voice>` +
        `</speak>`);
    });
  }
}

module.exports = { EdgeTTS };
