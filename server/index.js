const http = require("http");
const WebSocket = require("ws");
const config = require("./config");
const { VoiceSession } = require("./core/session");
const { MessageType, parseJsonMessage, jsonMessage } = require("../shared/protocol");

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let session;

  try {
    session = new VoiceSession(ws, config);
  } catch (error) {
    ws.send(jsonMessage(MessageType.ERROR, { message: error.message || String(error) }));
    ws.close();
    return;
  }

  ws.on("message", (data, isBinary) => {
    try {
      if (isBinary) {
        session.acceptAudio(Buffer.from(data));
        return;
      }

      const message = parseJsonMessage(data);
      if (!message?.type) return;

      if (message.type === MessageType.START) {
        session.start(message);
      } else if (message.type === MessageType.INTERRUPT) {
        session.interrupt("client");
      } else if (message.type === MessageType.PING) {
        session.sendJson(MessageType.PING, { timestamp: Date.now() });
      }
    } catch (error) {
      session.sendJson(MessageType.ERROR, { message: error.message || String(error) });
    }
  });

  ws.on("close", () => {
    if (session) session.close();
  });
});

server.listen(config.port, config.host, () => {
  console.log(`voice-relay server listening on ws://${config.host}:${config.port}/ws`);
  console.log(`ASR model: ${config.asr.modelDir}`);
});
