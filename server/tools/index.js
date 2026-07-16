const SEARCH_TIMEOUT_MS = 10000;
const SEARCH_MAX_RESULTS = 5;

const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get the current local date and time, precise to the minute.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web with Exa.ai for current or factual information. Use this when the answer may need recent internet results.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query."
          }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  }
];

function parseToolArguments(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getCurrentTime() {
  const now = new Date();
  return {
    iso: now.toISOString(),
    local: new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short"
    }).format(now)
  };
}

function pickSnippet(result) {
  if (result.summary) return result.summary;
  if (Array.isArray(result.highlights) && result.highlights.length > 0) return result.highlights.join(" ");
  if (result.text) return result.text.slice(0, 500);
  return "";
}

async function webSearch({ query }, signal, config = {}) {
  if (!query || typeof query !== "string") {
    throw new Error("web_search requires a query string");
  }
  if (!config.exaApiKey) {
    throw new Error("EXA_API_KEY is required for web_search");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.searchTimeoutMs || SEARCH_TIMEOUT_MS);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": config.exaApiKey
      },
      body: JSON.stringify({
        query,
        type: "instant",
        numResults: config.searchMaxResults || SEARCH_MAX_RESULTS,
        contents: {
          highlights: true
        }
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Exa search failed: HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ""}`);
    }

    const data = await response.json();
    return {
      query,
      provider: "Exa.ai",
      results: (data.results || []).map((result) => ({
        title: result.title || result.url || "Untitled",
        url: result.url,
        publishedDate: result.publishedDate || null,
        author: result.author || null,
        snippet: pickSnippet(result)
      }))
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function executeToolCall(toolCall, signal, config) {
  const name = toolCall.function?.name || toolCall.name;
  const args = parseToolArguments(toolCall.function?.arguments || toolCall.arguments);

  if (name === "get_current_time") return getCurrentTime();
  if (name === "web_search") return webSearch(args, signal, config);

  throw new Error(`Unknown tool: ${name || "missing_name"}`);
}

module.exports = {
  executeToolCall,
  toolDefinitions
};
