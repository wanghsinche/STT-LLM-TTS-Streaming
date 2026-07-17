const OpenAI = require("openai");

const INLINE_TOOL_MARKER = "<|message_model|>";
const INLINE_TOOL_ARGS_MARKER = "<|content_invoke_tool_json|>";
const INLINE_TOOL_END_MARKER = "<|end_message|>";

function parseInlineToolCalls(text) {
  if (!text.includes(INLINE_TOOL_MARKER) || !text.includes(INLINE_TOOL_ARGS_MARKER)) {
    return { text, toolCalls: [] };
  }

  const visibleText = text.slice(0, text.indexOf(INLINE_TOOL_MARKER));
  const toolCalls = [];
  const regex = /<\|message_model\|>([^<]+)<\|content_invoke_tool_json\|>([\s\S]*?)(?=<\|end_message\|>|<\|message_model\|>|$)/g;
  let match;
  while ((match = regex.exec(text))) {
    const name = match[1].trim();
    let args = match[2].trim();
    try {
      const parsed = JSON.parse(args);
      if (parsed.name && parsed.args && typeof parsed.args === "object") {
        args = JSON.stringify(parsed.args);
      }
    } catch {
      // Keep raw arguments so the tool executor can report a normal parse error.
    }
    toolCalls.push({
      id: `inline_call_${toolCalls.length}`,
      type: "function",
      function: { name, arguments: args }
    });
  }

  return { text: visibleText.replaceAll(INLINE_TOOL_END_MARKER, ""), toolCalls };
}

class OpenAICompatibleLLM {
  constructor(config) {
    if (!config.apiKey) {
      throw new Error("LLM_API_KEY is required");
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

  async streamChat({ messages, signal, onDelta, onReasoning, tools, toolChoice }) {
    const startedAt = Date.now();
    console.log(`[llm] chat stream request ${this.client.baseURL} model=${this.model} messages=${messages.length}`);

    const stream = await this.client.chat.completions.create(
      {
        messages,
        model: this.model,
        max_tokens: this.maxTokens,
        stream: true,
        temperature: this.temperature,
        top_p: this.topP,
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {})
      },
      { signal }
    );
    console.log(`[llm] stream connected in ${Date.now() - startedAt}ms`);

    let fullText = "";
    let chunkCount = 0;
    let contentCount = 0;
    let reasoningCount = 0;
    const toolCalls = [];
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
      for (const toolCall of chunk.choices?.[0]?.delta?.tool_calls || []) {
        const index = toolCall.index ?? toolCalls.length;
        if (!toolCalls[index]) {
          toolCalls[index] = {
            id: toolCall.id,
            type: toolCall.type || "function",
            function: { name: "", arguments: "" }
          };
        }
        if (toolCall.id) toolCalls[index].id = toolCall.id;
        if (toolCall.type) toolCalls[index].type = toolCall.type;
        if (toolCall.function?.name) toolCalls[index].function.name += toolCall.function.name;
        if (toolCall.function?.arguments) toolCalls[index].function.arguments += toolCall.function.arguments;
      }
      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (!delta) continue;
      contentCount += 1;
      fullText += delta;
      await onDelta(delta);
    }

    const inlineParsed = parseInlineToolCalls(fullText);
    const finalToolCalls = toolCalls.filter(Boolean).concat(inlineParsed.toolCalls);
    fullText = inlineParsed.text;
    console.log(`[llm] stream end in ${Date.now() - startedAt}ms chunks=${chunkCount} content=${contentCount} reasoning=${reasoningCount} tool_calls=${finalToolCalls.length} chars=${fullText.length}`);

    return { text: fullText, toolCalls: finalToolCalls };
  }
}

module.exports = { OpenAICompatibleLLM };
