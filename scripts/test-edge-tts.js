const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { EdgeTTS } = require("../server/tts/edge");

function boolFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw === "true" || raw === "1";
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    text: args.join(" ") || process.env.TTS_TEST_TEXT || "Hello, how can I help you today?",
    output: process.env.TTS_TEST_OUTPUT || path.resolve(__dirname, "../tmp/edge-tts-test.mp3")
  };
}

async function main() {
  const { text, output } = parseArgs();
  const config = {
    voice: process.env.TTS_VOICE || "zh-CN-XiaoxiaoNeural",
    rate: process.env.TTS_RATE || "+0%",
    format: process.env.TTS_FORMAT || "audio-24khz-48kbitrate-mono-mp3",
    timeoutMs: numberFromEnv("TTS_TIMEOUT_MS", 10000),
    tlsRejectUnauthorized: boolFromEnv(
      "TTS_TLS_REJECT_UNAUTHORIZED",
      boolFromEnv("LLM_TLS_REJECT_UNAUTHORIZED", true)
    )
  };

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const writeStream = fs.createWriteStream(output);
  const tts = new EdgeTTS(config);
  const startedAt = Date.now();
  let chunks = 0;
  let bytes = 0;

  console.log(`[tts-test] voice=${config.voice} format=${config.format} rate=${config.rate}`);
  console.log(`[tts-test] text=${text}`);
  console.log(`[tts-test] output=${output}`);

  await tts.synthesize(text, {
    onAudio: (chunk) => {
      chunks += 1;
      bytes += chunk.length;
      console.log(`[tts-test] audio chunk ${chunks}: ${chunk.length} bytes`);
      writeStream.write(chunk);
    }
  });

  await new Promise((resolve, reject) => {
    writeStream.end((error) => (error ? reject(error) : resolve()));
  });

  console.log(`[tts-test] done in ${Date.now() - startedAt}ms chunks=${chunks} bytes=${bytes}`);
}

main().catch((error) => {
  console.error(`[tts-test] ${error.message || error}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
