# Voice Relay WebSocket Protocol

Endpoint: `ws://host:8787/ws`

## Audio format

Client to server audio is binary PCM:

- codec: `pcm_s16le`
- sample rate: `16000`
- channels: `1`
- frame size: recommended `20ms` = 640 bytes

Server to client TTS audio defaults to Edge TTS MP3:

- codec: `mp3`
- sample rate: `24000`
- channels: `1`

## Client messages

Start session:

```json
{
  "type": "start",
  "session_id": "client-generated-id",
  "audio": {
    "codec": "pcm_s16le",
    "sample_rate": 16000,
    "channels": 1,
    "frame_ms": 20
  }
}
```

Audio chunk:

```text
Binary pcm_s16le bytes
```

Interrupt:

```json
{"type":"interrupt"}
```

## Server messages

Ready:

```json
{"type":"ready","session_id":"...","audio":{"codec":"pcm_s16le","sample_rate":16000,"channels":1,"frame_ms":20}}
```

ASR final result:

```json
{"type":"asr.final","text":"你好","timestamp":1730000000000}
```

LLM text stream:

```json
{"type":"llm.delta","text":"好的","timestamp":1730000000000}
```

TTS chunk boundary:

```json
{"type":"tts.start","text":"好的。","format":{"codec":"mp3","sample_rate":24000,"channels":1}}
```

Then server sends binary audio chunks in the announced TTS codec.

```json
{"type":"tts.end","timestamp":1730000000000}
```

Turn complete:

```json
{"type":"turn.end","timestamp":1730000000000}
```

Interrupted:

```json
{"type":"interrupted","reason":"client","timestamp":1730000000000}
```

Error:

```json
{"type":"error","message":"..."}
```
