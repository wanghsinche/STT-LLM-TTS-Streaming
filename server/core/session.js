const crypto = require("crypto");
const { MessageType, jsonMessage } = require("../../shared/protocol");
const { TextChunker } = require("./text-chunker");
const { LocalSherpaASR } = require("../asr/local-sherpa");
const { NvidiaLLM } = require("../llm/nvidia");
const { EdgeTTS } = require("../tts/edge");
const { executeToolCall, toolDefinitions } = require("../tools");

const FILLER_DELAY_MS = 1200;
const REASONING_FILLER_DELAY_MS = 2000;
const REASONING_FOLLOWUP_DELAY_MS = 6000;
const MAX_REASONING_FILLERS = 2;
const FILLER_AFTER_PAUSE_MS = 350;
const FILLERS = ["嗯，我看一下。", "好的，我想想。", "稍等，我看看。"];
const REASONING_FILLERS = ["我再想想。", "这个我多琢磨一下。"];
const SYSTEM_PROMPT = "你是一个低延迟语音助手。回答要自然、简短，适合被 TTS 朗读。不要使用 Markdown、列表符号、代码块、表格、标题或其他排版标记。需要当前时间时使用 get_current_time。需要实时信息、联网信息、新闻、价格、天气、资料查询或你不确定的新信息时使用 web_search。工具结果要自然转述，不要输出 JSON。";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTTSFormat(format) {
  if (format.includes("webm")) return { codec: "webm_opus", sample_rate: 24000, channels: 1 };
  if (format.includes("mp3")) return { codec: "mp3", sample_rate: 24000, channels: 1 };
  if (format.includes("raw")) return { codec: "pcm_s16le", sample_rate: format.includes("16khz") ? 16000 : 24000, channels: 1 };
  return { codec: "mp3", sample_rate: 24000, channels: 1 };
}

function normalizeForTTS(text) {
  return text
    .replace(/```[\s\S]*?```/g, "代码内容略。")
    .replace(/!\[[^\]]*\]\([^\s)]+\)/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^\s)]+\)/g, "$1")
    .replace(/^\s*\|?\s*[-:]+\s*(\|\s*[-:]+\s*)+\|?\s*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
    .replace(/\$([^\n$]+)\$/g, "$1")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/\|/g, "，")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function stringifyToolResult(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

class VoiceSession {
  constructor(ws, config) {
    this.ws = ws;
    this.config = config;
    this.id = crypto.randomUUID();
    this.history = [];
    this.asr = new LocalSherpaASR(config.asr);
    this.llm = new NvidiaLLM(config.llm);
    this.tts = new EdgeTTS(config.tts);
    this.textChunker = new TextChunker();
    this.abortController = null;
    this.responding = false;
    this.ttsChain = Promise.resolve();
    this.fillerTimer = null;
    this.reasoningFillerTimer = null;
    this.fillerSpoken = false;
    this.reasoningFillerCount = 0;
    this.closed = false;

    this.asr.on("final", ({ text, timestamp }) => {
      if (this.responding) {
        console.log(`[${this.id}] ASR final ignored while responding: ${text}`);
        return;
      }
      console.log(`[${this.id}] ASR final: ${text}`);
      this.sendJson(MessageType.ASR_FINAL, { text, timestamp });
      void this.handleUserText(text);
    });
  }

  start(message) {
    this.audioFormat = message.audio || {};
    console.log(`[${this.id}] session started`, this.audioFormat);
    this.sendJson(MessageType.READY, {
      session_id: this.id,
      audio: {
        codec: "pcm_s16le",
        sample_rate: this.config.asr.sampleRate,
        channels: 1,
        frame_ms: 20
      },
      tts: getTTSFormat(this.config.tts.format)
    });
  }

  acceptAudio(buffer) {
    this.asr.acceptPcm16(buffer);
  }

  async handleUserText(text) {
    if (!text) return;
    this.interrupt("new_turn", { notify: Boolean(this.abortController || this.responding) });

    const controller = new AbortController();
    this.abortController = controller;
    controller.signal.addEventListener("abort", () => {
      console.log(`[${this.id}] turn aborted`);
    }, { once: true });
    this.responding = true;
    this.textChunker.clear();
    this.ttsChain = Promise.resolve();
    this.clearFillerTimer();
    this.clearReasoningFillerTimer();
    this.fillerSpoken = false;
    this.reasoningFillerCount = 0;

    const userMessage = { role: "user", content: text };
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...this.history.slice(-8),
      userMessage
    ];

    let assistantText = "";
    let realTTSStarted = false;
    try {
      console.log(`[${this.id}] LLM start: ${text}`);
      this.scheduleFiller(controller.signal);
      const pushAssistantDelta = async (delta) => {
        assistantText += delta;
        process.stdout.write(delta);
        this.sendJson(MessageType.LLM_DELTA, { text: delta, timestamp: Date.now() });
        for (const chunk of this.textChunker.push(delta)) {
          if (!realTTSStarted) {
            realTTSStarted = true;
            this.clearFillerTimer();
            this.clearReasoningFillerTimer();
          }
          this.enqueueTTS(chunk, controller.signal);
        }
      };

      const firstResponse = await this.llm.streamChat({
        messages,
        signal: controller.signal,
        tools: toolDefinitions,
        onReasoning: async () => {
          if (!realTTSStarted) this.scheduleReasoningFiller(controller.signal);
        },
        onDelta: pushAssistantDelta
      });

      if (firstResponse.toolCalls.length > 0 && !controller.signal.aborted) {
        console.log(`[${this.id}] executing ${firstResponse.toolCalls.length} tool call(s)`);
        const toolMessages = [];
        for (let index = 0; index < firstResponse.toolCalls.length; index += 1) {
          const toolCall = firstResponse.toolCalls[index];
          const name = toolCall.function?.name || "unknown";
          const toolCallId = toolCall.id || `call_${index}`;
          if (!toolCall.id) toolCall.id = toolCallId;
          console.log(`[${this.id}] tool start: ${name}`);
          try {
            const result = await executeToolCall(toolCall, controller.signal, this.config.tools);
            toolMessages.push({
              role: "tool",
              tool_call_id: toolCallId,
              content: stringifyToolResult(result)
            });
            console.log(`[${this.id}] tool end: ${name}`);
          } catch (error) {
            toolMessages.push({
              role: "tool",
              tool_call_id: toolCallId,
              content: stringifyToolResult({ error: error.message || String(error) })
            });
            console.error(`[${this.id}] tool error ${name}:`, error.message || error);
          }
        }

        this.textChunker.clear();
        assistantText = "";
        await this.llm.streamChat({
          messages: [
            ...messages,
            {
              role: "assistant",
              content: firstResponse.text || null,
              tool_calls: firstResponse.toolCalls
            },
            ...toolMessages
          ],
          signal: controller.signal,
          onReasoning: async () => {
            if (!realTTSStarted) this.scheduleReasoningFiller(controller.signal);
          },
          onDelta: pushAssistantDelta
        });
      }
      console.log(`[${this.id}] LLM stream complete, assistantText=${assistantText.length} chars`);

      for (const chunk of this.textChunker.flush()) {
        console.log(`[${this.id}] TTS enqueue flush: ${chunk}`);
        if (!realTTSStarted) {
          realTTSStarted = true;
          this.clearFillerTimer();
          this.clearReasoningFillerTimer();
        }
        this.enqueueTTS(chunk, controller.signal);
      }

      console.log(`[${this.id}] waiting TTS chain`);
      await this.ttsChain;
      console.log(`[${this.id}] TTS chain complete`);

      if (!controller.signal.aborted) {
        process.stdout.write("\n");
        console.log(`[${this.id}] LLM end: ${assistantText.length} chars`);
        this.history.push(userMessage, { role: "assistant", content: assistantText });
        this.sendJson(MessageType.TURN_END, { timestamp: Date.now() });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error(`[${this.id}] LLM/TTS error:`, error.message || error);
        this.sendJson(MessageType.ERROR, { message: error.message || String(error) });
      }
    } finally {
      this.clearFillerTimer();
      this.clearReasoningFillerTimer();
      if (this.abortController === controller) {
        this.abortController = null;
        this.responding = false;
      }
    }
  }

  pickFiller() {
    return FILLERS[Math.floor(Math.random() * FILLERS.length)];
  }

  pickReasoningFiller() {
    return REASONING_FILLERS[Math.min(this.reasoningFillerCount, REASONING_FILLERS.length - 1)];
  }

  scheduleFiller(signal) {
    this.clearFillerTimer();
    this.fillerTimer = setTimeout(() => {
      this.fillerTimer = null;
      if (signal.aborted || this.fillerSpoken) return;
      const text = this.pickFiller();
      this.fillerSpoken = true;
      this.reasoningFillerCount = Math.max(this.reasoningFillerCount, 1);
      console.log(`[${this.id}] TTS filler enqueue: ${text}`);
      this.enqueueTTS(text, signal, { filler: true });
    }, FILLER_DELAY_MS);
  }

  scheduleReasoningFiller(signal) {
    if (this.reasoningFillerCount >= MAX_REASONING_FILLERS || this.reasoningFillerTimer) return;
    this.clearFillerTimer();
    const delay = this.reasoningFillerCount === 0 ? REASONING_FILLER_DELAY_MS : REASONING_FOLLOWUP_DELAY_MS;
    this.reasoningFillerTimer = setTimeout(() => {
      this.reasoningFillerTimer = null;
      if (signal.aborted || this.reasoningFillerCount >= MAX_REASONING_FILLERS) return;
      const text = this.pickReasoningFiller();
      this.fillerSpoken = true;
      this.reasoningFillerCount += 1;
      console.log(`[${this.id}] TTS reasoning filler enqueue: ${text}`);
      this.enqueueTTS(text, signal, { filler: true });
    }, delay);
  }

  clearFillerTimer() {
    if (!this.fillerTimer) return;
    clearTimeout(this.fillerTimer);
    this.fillerTimer = null;
  }

  clearReasoningFillerTimer() {
    if (!this.reasoningFillerTimer) return;
    clearTimeout(this.reasoningFillerTimer);
    this.reasoningFillerTimer = null;
  }

  enqueueTTS(text, signal, options = {}) {
    const spokenText = options.filler ? text : normalizeForTTS(text);
    if (!spokenText) return this.ttsChain;
    console.log(`[${this.id}] TTS enqueue: ${spokenText}`);
    const next = this.ttsChain.catch(() => undefined).then(async () => {
      if (signal.aborted || !spokenText) return;
      console.log(`[${this.id}] TTS start: ${spokenText}`);
      this.sendJson(MessageType.TTS_START, {
        text: spokenText,
        format: getTTSFormat(this.config.tts.format)
      });
      try {
        await this.tts.synthesize(spokenText, {
          signal,
          onAudio: (chunk) => this.sendBinary(chunk)
        });
      } catch (error) {
        if (!signal.aborted) {
          console.error(`[${this.id}] TTS error:`, error.message || error);
        }
      } finally {
        console.log(`[${this.id}] TTS end: ${spokenText.length} chars`);
        this.sendJson(MessageType.TTS_END, { timestamp: Date.now() });
        if (options.filler && !signal.aborted) {
          await sleep(FILLER_AFTER_PAUSE_MS);
        }
      }
    });
    this.ttsChain = next;
    return this.ttsChain;
  }

  interrupt(reason = "client", options = {}) {
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort();
    }
    this.clearFillerTimer();
    this.clearReasoningFillerTimer();
    this.textChunker.clear();
    this.responding = false;
    if (options.notify !== false) {
      this.sendJson(MessageType.INTERRUPTED, { reason, timestamp: Date.now() });
    }
  }

  sendJson(type, data = {}) {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(jsonMessage(type, data));
  }

  sendBinary(buffer) {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(buffer, { binary: true });
  }

  close() {
    this.closed = true;
    this.interrupt("close");
    this.asr.close();
  }
}

module.exports = { VoiceSession };
