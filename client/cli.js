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
  let currentTTS = null;
  let activeTTS = null;
  const playbackQueue = [];
  let playbackActive = false;
  let turnEnded = false;
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

  const maybeUnmuteAfterTurn = () => {
    if (!turnEnded || playbackActive || currentTTS || playbackQueue.length > 0) return;
    unmuteMicSoon();
  };

  const writeSegmentChunk = (segment, chunk) => {
    if (!segment.player || segment.player.stdin.destroyed || segment.player.stdin.writableEnded) {
      segment.buffers.push(chunk);
      return;
    }
    segment.player.stdin.write(chunk);
  };

  const acceptSegmentChunk = (segment, chunk) => {
    segment.bytes += chunk.length;
    writeSegmentChunk(segment, chunk);
  };

  const finishSegmentInput = (segment) => {
    if (!segment.player || segment.player.stdin.destroyed || segment.player.stdin.writableEnded) return;
    segment.player.stdin.end();
  };

  const playAudioSegment = (segment) => new Promise((resolve) => {
    const child = startAudioPlayback(segment.format);
    segment.player = child;
    activeTTS = segment;
    player = child;
    child.once("close", () => {
      if (player === child) player = null;
      if (activeTTS === segment) activeTTS = null;
      console.log(`[tts audio bytes: ${segment.bytes}]`);
      resolve();
    });
    child.once("error", (error) => {
      console.error(`[playback] ${error.message || error}`);
      if (player === child) player = null;
      if (activeTTS === segment) activeTTS = null;
      resolve();
    });

    for (const chunk of segment.buffers.splice(0)) {
      writeSegmentChunk(segment, chunk);
    }
    if (segment.ended) finishSegmentInput(segment);
  });

  const processPlaybackQueue = async () => {
    if (playbackActive) return;
    playbackActive = true;
    try {
      while (playbackQueue.length > 0) {
        await playAudioSegment(playbackQueue[0]);
        playbackQueue.shift();
      }
    } finally {
      playbackActive = false;
      maybeUnmuteAfterTurn();
    }
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
      if (!currentTTS) {
        currentTTS = { format: ttsFormat, buffers: [], bytes: 0, ended: false, player: null };
      }
      acceptSegmentChunk(currentTTS, Buffer.from(data));
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
      turnEnded = false;
      currentTTS = { format: ttsFormat, buffers: [], bytes: 0, ended: false, player: null };
      playbackQueue.push(currentTTS);
      void processPlaybackQueue();
      setMicMuted(true);
      process.stdout.write("\nTTS> ");
    } else if (message.type === MessageType.TTS_END) {
      if (currentTTS) {
        currentTTS.ended = true;
        finishSegmentInput(currentTTS);
        currentTTS = null;
      }
    } else if (message.type === MessageType.TURN_END) {
      turnEnded = true;
      maybeUnmuteAfterTurn();
      process.stdout.write("\n--- turn end ---\n");
    } else if (message.type === MessageType.INTERRUPTED) {
      currentTTS = null;
      playbackQueue.length = 0;
      activeTTS = null;
      turnEnded = false;
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
