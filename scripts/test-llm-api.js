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
    timeoutMs: numberFromEnv("LLM_TEST_TIMEOUT_MS", 30000),
    prompt: process.env.LLM_TEST_PROMPT || "用一句中文介绍你自己。"
  };
}

async function testChatCompletions({ client, model, prompt, stream }) {
  const content = process.env.LLM_TEST_IMAGE_URL
    ? [
        {
          type: "image_url",
          image_url: { url: process.env.LLM_TEST_IMAGE_URL }
        },
        { type: "text", text: prompt }
      ]
    : prompt;
  const payload = {
    messages: [{ role: "user", content }],
    model,
    max_tokens: numberFromEnv("LLM_MAX_TOKENS", 4096),
    stream,
    temperature: numberFromEnv("LLM_TEMPERATURE", 1),
    top_p: numberFromEnv("LLM_TOP_P", 1)
  };
  const response = await client.chat.completions.create(payload);

  if (!stream) {
    const message = response.choices?.[0]?.message;
    if (message?.reasoning_content) process.stdout.write(`${message.reasoning_content}\n`);
    process.stdout.write(message?.content || JSON.stringify(response, null, 2));
    return;
  }

  for await (const chunk of response) {
    const delta = chunk.choices?.[0]?.delta?.content || "";
    if (delta) process.stdout.write(delta);
  }
}

async function main() {
  const apiKey = process.env.LLM_API_KEY || process.env.ARK_API_KEY;
  if (!apiKey) throw new Error("LLM_API_KEY is missing in .env");

  const { stream, timeoutMs, prompt } = parseArgs();
  if (boolFromEnv("LLM_TLS_REJECT_UNAUTHORIZED", true) === false) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    console.warn("[llm-test] TLS certificate verification is disabled");
  }
  const client = new OpenAI({
    apiKey,
    baseURL: process.env.LLM_BASE_URL || "https://integrate.api.nvidia.com/v1",
    timeout: timeoutMs
  });
  const model = process.env.LLM_MODEL || "mistralai/mistral-small-4-119b-2603";

  console.log(`[llm-test] baseURL=${client.baseURL}`);
  console.log(`[llm-test] model=${model} stream=${stream} timeout=${timeoutMs}ms`);
  console.log(`[llm-test] prompt=${prompt}`);

  const startedAt = Date.now();
  await testChatCompletions({ client, model, prompt, stream });
  process.stdout.write(`\n[llm-test] done in ${Date.now() - startedAt}ms\n`);
}

main().catch((error) => {
  console.error(`[llm-test] ${error.message || error}`);
  if (error.status) console.error(`[llm-test] status=${error.status}`);
  if (error.code) console.error(`[llm-test] code=${error.code}`);
  if (error.cause) console.error("[llm-test] cause=", error.cause);
  if (error.error) console.error(error.error);
  process.exit(1);
});
