const OpenAI = require("openai");

class NvidiaLLM {
  constructor(config) {
    if (!config.apiKey) {
      throw new Error("NVIDIA_API_KEY is required");
    }
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.temperature = config.temperature;
    this.topP = config.topP;
    if (config.tlsRejectUnauthorized === false) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      console.warn("[llm] TLS certificate verification is disabled");
    }
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeoutMs || 30000
    });
  }

  async streamChat({ messages, signal, onDelta, onReasoning }) {
    const startedAt = Date.now();
    console.log(`[llm] stream request ${this.client.baseURL} model=${this.model} messages=${messages.length}`);

    const stream = await this.client.chat.completions.create(
      {
        messages,
        model: this.model,
        max_tokens: this.maxTokens,
        stream: true,
        temperature: this.temperature,
        top_p: this.topP
      },
      { signal }
    );
    console.log(`[llm] stream connected in ${Date.now() - startedAt}ms`);

    let fullText = "";
    let chunkCount = 0;
    let contentCount = 0;
    let reasoningCount = 0;
    for await (const chunk of stream) {
      chunkCount += 1;
      if (chunkCount === 1) {
        console.log(`[llm] first chunk in ${Date.now() - startedAt}ms`);
      }
      if (signal?.aborted) {
        console.log(`[llm] stream aborted after chunks=${chunkCount} content=${contentCount} reasoning=${reasoningCount}`);
        break;
      }
      const reasoning = chunk.choices?.[0]?.delta?.reasoning_content || "";
      if (reasoning) {
        reasoningCount += 1;
        if (reasoningCount === 1 || reasoningCount % 25 === 0) {
          process.stdout.write(`[reasoning x${reasoningCount}]`);
        }
        if (onReasoning) await onReasoning(reasoning);
      }
      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (!delta) continue;
      contentCount += 1;
      fullText += delta;
      await onDelta(delta);
    }

    console.log(`[llm] stream end in ${Date.now() - startedAt}ms chunks=${chunkCount} content=${contentCount} reasoning=${reasoningCount} chars=${fullText.length}`);

    return fullText;
  }
}

module.exports = { NvidiaLLM };
