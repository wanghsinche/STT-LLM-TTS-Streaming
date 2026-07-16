# Voice Relay

Low-latency Node.js streaming voice relay server:

```text
mic/ESP32 -> WebSocket PCM -> local sherpa-onnx ASR -> Nvidia streaming LLM -> Edge TTS -> WebSocket audio
```

## Setup

```bash
cd voice-relay
npm install
cp .env.example .env
npm run download:asr-model
```

Set `NVIDIA_API_KEY` in `.env`.

If HuggingFace is slow, use a mirror:

```bash
HF_ENDPOINT=https://hf-mirror.com npm run download:asr-model
```

## Test Nvidia API

```bash
npm run test:nvidia
npm run test:nvidia:stream
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
- Current TTS adapter uses the Node package `node-edge-tts` and defaults to 24k mono MP3.
