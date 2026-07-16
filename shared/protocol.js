const MessageType = Object.freeze({
  START: "start",
  INTERRUPT: "interrupt",
  PING: "ping",
  READY: "ready",
  ERROR: "error",
  ASR_PARTIAL: "asr.partial",
  ASR_FINAL: "asr.final",
  LLM_DELTA: "llm.delta",
  TTS_START: "tts.start",
  TTS_END: "tts.end",
  INTERRUPTED: "interrupted",
  TURN_END: "turn.end"
});

const DefaultAudioFormat = Object.freeze({
  codec: "pcm_s16le",
  sample_rate: 16000,
  channels: 1,
  frame_ms: 20
});

function jsonMessage(type, data = {}) {
  return JSON.stringify({ type, ...data });
}

function parseJsonMessage(data) {
  try {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = {
  MessageType,
  DefaultAudioFormat,
  jsonMessage,
  parseJsonMessage
};
