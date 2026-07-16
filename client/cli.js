const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const ffmpeg = require("@ffmpeg-installer/ffmpeg");
const { MessageType, DefaultAudioFormat, jsonMessage, parseJsonMessage } = require("../shared/protocol");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const wsUrl = process.env.CLIENT_WS_URL || "ws://127.0.0.1:8787/ws";
const device = process.env.CLIENT_AUDIO_DEVICE || "";
const muteMicDuringTTS = process.env.CLIENT_MUTE_MIC_DURING_TTS !== "false";
const unmuteDelayMs = Number(process.env.CLIENT_UNMUTE_DELAY_MS || 500);

function getFfmpegInputArgs() {
  if (process.platform === "darwin") {
    return ["-f", "avfoundation", "-i", device || ":0"];
  }
  if (process.platform === "win32") {
    return ["-f", "dshow", "-i", device ? `audio=${device}` : "audio=Microphone"];
  }
  return ["-f", "alsa", "-i", device || "default"];
}

function startMicCapture(onChunk) {
  const args = [
    ...getFfmpegInputArgs(),
    "-acodec",
    "pcm_s16le",
    "-ar",
    String(DefaultAudioFormat.sample_rate),
    "-ac",
    String(DefaultAudioFormat.channels),
    "-f",
    "s16le",
    "pipe:1"
  ];

  const child = spawn(ffmpeg.path, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", onChunk);
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    if (/error|failed|cannot/i.test(text)) process.stderr.write(text);
  });
  child.on("close", (code) => {
    console.log(`mic ffmpeg exited: ${code}`);
  });
  return child;
}

function startAudioPlayback(format = {}) {
  const codec = format.codec || "mp3";
  const inputFormat = codec === "webm_opus" ? "webm" : codec;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    inputFormat,
    "-i",
    "pipe:0",
    "-f",
    process.platform === "darwin" ? "audiotoolbox" : "wav",
    process.platform === "darwin" ? "default" : "pipe:1"
  ];
  const child = spawn(ffmpeg.path, args, { stdio: ["pipe", process.platform === "darwin" ? "ignore" : "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => process.stderr.write(`[playback] ${chunk}`));
  return child;
}

function main() {
  console.log(`connecting ${wsUrl}`);
  console.log(`platform=${os.platform()} mic=${device || "default"}`);

  const ws = new WebSocket(wsUrl);
  let mic;
  let player;
  let ttsFormat = { codec: "mp3" };
  let micMuted = false;
  let unmuteTimer = null;

  const setMicMuted = (muted) => {
    if (!muteMicDuringTTS) return;
    if (unmuteTimer) {
      clearTimeout(unmuteTimer);
      unmuteTimer = null;
    }
    if (micMuted !== muted) {
      micMuted = muted;
      console.log(muted ? "[mic muted during TTS]" : "[mic unmuted]");
    }
  };

  const unmuteMicSoon = () => {
    if (!muteMicDuringTTS) return;
    if (unmuteTimer) clearTimeout(unmuteTimer);
    unmuteTimer = setTimeout(() => {
      micMuted = false;
      unmuteTimer = null;
      console.log("[mic unmuted]");
    }, Number.isFinite(unmuteDelayMs) ? unmuteDelayMs : 500);
  };

  const finishPlaybackThenUnmute = () => {
    if (!player) {
      unmuteMicSoon();
      return;
    }
    const currentPlayer = player;
    currentPlayer.once("close", () => {
      if (player === currentPlayer) player = null;
      unmuteMicSoon();
    });
    if (!currentPlayer.stdin.destroyed) currentPlayer.stdin.end();
  };

  ws.on("open", () => {
    ws.send(jsonMessage(MessageType.START, {
      session_id: crypto.randomUUID?.() || String(Date.now()),
      audio: DefaultAudioFormat
    }));

    mic = startMicCapture((chunk) => {
      if (micMuted) return;
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
    });

    console.log("recording. Press Enter to interrupt, Ctrl+C to exit.");
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!player || player.killed || player.stdin.destroyed) {
        player = startAudioPlayback(ttsFormat);
      }
      player.stdin.write(Buffer.from(data));
      return;
    }

    const message = parseJsonMessage(data);
    if (!message) return;

    if (message.type === MessageType.READY) {
      console.log("server ready", message.audio);
    } else if (message.type === MessageType.ASR_FINAL) {
      console.log(`\nASR: ${message.text}`);
    } else if (message.type === MessageType.LLM_DELTA) {
      process.stdout.write(message.text);
    } else if (message.type === MessageType.TTS_START) {
      ttsFormat = message.format || ttsFormat;
      setMicMuted(true);
      if (!player || player.killed || player.stdin.destroyed) {
        player = startAudioPlayback(ttsFormat);
      }
      process.stdout.write("\nTTS> ");
    } else if (message.type === MessageType.TURN_END) {
      finishPlaybackThenUnmute();
      process.stdout.write("\n--- turn end ---\n");
    } else if (message.type === MessageType.INTERRUPTED) {
      if (player) {
        player.kill("SIGTERM");
        player = null;
      }
      setMicMuted(false);
      process.stdout.write(`\n[interrupted: ${message.reason}]\n`);
    } else if (message.type === MessageType.ERROR) {
      console.error("server error:", message.message);
    }
  });

  process.stdin.setRawMode?.(false);
  process.stdin.resume();
  process.stdin.on("data", () => {
    if (ws.readyState === WebSocket.OPEN) ws.send(jsonMessage(MessageType.INTERRUPT));
  });

  const cleanup = () => {
    if (unmuteTimer) clearTimeout(unmuteTimer);
    if (mic) mic.kill("SIGTERM");
    if (player) player.kill("SIGTERM");
    if (ws.readyState === WebSocket.OPEN) ws.close();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main();
