const path = require("path");
const OpenAI = require("openai");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function boolFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw === "true" || raw === "1";
}

function parseArgs() {
  const args = new Set(process.argv.slice(2));
  return {
    stream: args.has("--stream"),
    timeoutMs: numberFromEnv("NVIDIA_TEST_TIMEOUT_MS", 30000),
    prompt: process.env.NVIDIA_TEST_PROMPT || "用一句中文介绍你自己。"
  };
}

async function main() {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY is missing in .env");

  const { stream, timeoutMs, prompt } = parseArgs();
  if (boolFromEnv("NVIDIA_TLS_REJECT_UNAUTHORIZED", true) === false) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    console.warn("[nvidia-test] TLS certificate verification is disabled");
  }
  const client = new OpenAI({
    apiKey,
    baseURL: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
    timeout: timeoutMs
  });
  const payload = {
    messages: [{ role: "user", content: prompt }],
    model: process.env.NVIDIA_MODEL || "openai/gpt-oss-120b",
    max_tokens: numberFromEnv("NVIDIA_MAX_TOKENS", 4096),
    stream,
    temperature: numberFromEnv("NVIDIA_TEMPERATURE", 1),
    top_p: numberFromEnv("NVIDIA_TOP_P", 1)
  };

  console.log(`[nvidia-test] baseURL=${client.baseURL}`);
  console.log(`[nvidia-test] model=${payload.model} stream=${stream} timeout=${timeoutMs}ms`);
  console.log(`[nvidia-test] prompt=${prompt}`);

  const startedAt = Date.now();
  const response = await client.chat.completions.create(payload);
  console.log(`[nvidia-test] done in ${Date.now() - startedAt}ms`);

  if (!stream) {
    const message = response.choices?.[0]?.message;
    if (message?.reasoning_content) process.stdout.write(`${message.reasoning_content}\n`);
    process.stdout.write(message?.content || JSON.stringify(response, null, 2));
    process.stdout.write("\n");
    return;
  }

  for await (const chunk of response) {
    const delta = chunk.choices?.[0]?.delta?.content || "";
    if (delta) process.stdout.write(delta);
  }
  process.stdout.write("\n[nvidia-test] stream end\n");
}

main().catch((error) => {
  console.error(`[nvidia-test] ${error.message || error}`);
  if (error.status) console.error(`[nvidia-test] status=${error.status}`);
  if (error.code) console.error(`[nvidia-test] code=${error.code}`);
  if (error.cause) console.error("[nvidia-test] cause=", error.cause);
  if (error.error) console.error(error.error);
  process.exit(1);
});
