const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function stringFromEnv(name, fallback) {
  return process.env[name] || fallback;
}

function boolFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw === "true" || raw === "1";
}

const rootDir = path.resolve(__dirname, "..");

module.exports = {
  rootDir,
  host: process.env.HOST || "0.0.0.0",
  port: numberFromEnv("PORT", 8787),
  asr: {
    modelDir: path.resolve(rootDir, process.env.ASR_MODEL_DIR || "./models/sherpa-onnx-paraformer-zh-2024-03-09"),
    sampleRate: numberFromEnv("ASR_SAMPLE_RATE", 16000),
    endpointSilenceMs: numberFromEnv("ASR_ENDPOINT_SILENCE_MS", 800)
  },
  llm: {
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: stringFromEnv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"),
    model: stringFromEnv("NVIDIA_MODEL", "openai/gpt-oss-120b"),
    maxTokens: numberFromEnv("NVIDIA_MAX_TOKENS", 4096),
    temperature: numberFromEnv("NVIDIA_TEMPERATURE", 1),
    topP: numberFromEnv("NVIDIA_TOP_P", 1),
    timeoutMs: numberFromEnv("NVIDIA_TIMEOUT_MS", 30000),
    tlsRejectUnauthorized: boolFromEnv("NVIDIA_TLS_REJECT_UNAUTHORIZED", true)
  },
  tts: {
    voice: process.env.TTS_VOICE || "zh-CN-XiaoxiaoNeural",
    rate: process.env.TTS_RATE || "+0%",
    format: process.env.TTS_FORMAT || "raw-16khz-16bit-mono-pcm",
    timeoutMs: numberFromEnv("TTS_TIMEOUT_MS", 10000),
    tlsRejectUnauthorized: boolFromEnv(
      "TTS_TLS_REJECT_UNAUTHORIZED",
      boolFromEnv("NVIDIA_TLS_REJECT_UNAUTHORIZED", true)
    )
  }
};
