# Voice Relay

Low-latency Node.js streaming voice relay server:

```text
mic/ESP32 -> WebSocket PCM -> local sherpa-onnx ASR -> OpenAI-compatible streaming LLM -> Edge TTS -> WebSocket audio
```

## Setup

```bash
cd voice-relay
npm install
cp .env.example .env
npm run download:asr-model
```

Set `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` in `.env`. Set `EXA_API_KEY` too if you want the assistant to use the `web_search` tool.

For OpenAI-compatible providers such as ARK:

```bash
LLM_API_KEY=$ARK_API_KEY
LLM_BASE_URL=https://ark-cn-beijing.bytedance.net/api/v3
LLM_MODEL=ep-20251227174236-pbsxr
```

To test image input with Chat Completions:

```bash
LLM_TEST_IMAGE_URL=https://ark-project.tos-cn-beijing.ivolces.com/images/view.jpeg \
LLM_TEST_PROMPT=这是哪里？ \
npm run test:llm
```

If HuggingFace is slow, use a mirror:

```bash
HF_ENDPOINT=https://hf-mirror.com npm run download:asr-model
```

## Test LLM API

```bash
npm run test:llm
npm run test:llm:stream
```

## Run server

```bash
npm run server
```

Server listens on:

```text
ws://127.0.0.1:8787/ws
```

## Run PC CLI client

```bash
npm run client
```

Mac default mic uses ffmpeg avfoundation input `:0`. To select another device:

```bash
CLIENT_AUDIO_DEVICE=":1" npm run client
```

Windows example:

```bash
CLIENT_AUDIO_DEVICE="Microphone Array" npm run client
```

## Protocol

See `docs/ws_protocol.md`.

## Notes

- Client audio must be `pcm_s16le / 16000Hz / mono`.
- Press Enter in the CLI client to send an interrupt.
- Current TTS adapter uses `edge-tts-universal` and defaults to 24k mono MP3.
- The assistant can call tools for time, Exa web search, automatic context compaction, and silent no-op turns for ambient speech.
