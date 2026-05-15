import type {
  ConnectProviderInput,
  IndexedDocumentRecord,
  Message,
  ProviderConnection,
  ProviderKind,
  ProviderModel,
  SearchResult
} from "@fschat/shared";
import { callCodexText } from "./codex-client";

type ProviderSecret = {
  apiKey?: string;
};

type DiscoveredModel = Omit<ProviderModel, "id" | "connectionId" | "createdAt" | "updatedAt">;

type ProviderDiscovery = {
  models: DiscoveredModel[];
  warnings: string[];
};

const DEFAULT_BASE_URLS = {
  openai: "https://api.openai.com",
  "openai-codex": "",
  "azure-openai": "",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  ollama: "http://127.0.0.1:11434"
} as const;

const CODEX_DISCOVERED_MODELS: Array<{
  id: string;
  displayName: string;
  description: string;
}> = [
  {
    id: "chatgpt-plan-default",
    displayName: "Default (latest bundled)",
    description: "Maps to the app's current Codex fallback model when no specific Codex model is selected."
  },
  {
    id: "gpt-5.5",
    displayName: "gpt-5.5",
    description: "Bundled Codex-compatible model. Actual availability depends on what the ChatGPT Codex backend accepts for your account."
  },
  {
    id: "gpt-5.4",
    displayName: "gpt-5.4",
    description: "Bundled Codex-compatible model. Actual availability depends on what the ChatGPT Codex backend accepts for your account."
  },
  {
    id: "gpt-5.3-codex",
    displayName: "gpt-5.3-codex",
    description: "Bundled Codex-compatible model. Actual availability depends on what the ChatGPT Codex backend accepts for your account."
  },
  {
    id: "gpt-5.2-codex",
    displayName: "gpt-5.2-codex",
    description: "Bundled Codex-compatible model. Actual availability depends on what the ChatGPT Codex backend accepts for your account."
  },
  {
    id: "gpt-5.1-codex-max",
    displayName: "gpt-5.1-codex-max",
    description: "Bundled Codex-compatible model. Actual availability depends on what the ChatGPT Codex backend accepts for your account."
  },
  {
    id: "gpt-5.1-codex-mini",
    displayName: "gpt-5.1-codex-mini",
    description: "Bundled Codex-compatible model. Actual availability depends on what the ChatGPT Codex backend accepts for your account."
  },
  {
    id: "gpt-5.2",
    displayName: "gpt-5.2",
    description: "Bundled Codex-compatible model. Actual availability depends on what the ChatGPT Codex backend accepts for your account."
  }
];

export async function generateAssistantReply(args: {
  connection: ProviderConnection;
  model: ProviderModel;
  secret: ProviderSecret;
  searchResults: SearchResult[];
  contextNotes?: string[];
  history: Message[];
  userMessage: string;
  systemPrompt?: string;
}): Promise<string> {
  const { connection, model, secret, searchResults, contextNotes = [], history, userMessage, systemPrompt } = args;
  const noteBlock =
    contextNotes.length > 0
      ? ["Context notes:", ...contextNotes.map((note, index) => `- ${note}`), ""].join("\n")
      : "";
  const contextBlock =
    searchResults.length === 0
      ? `${noteBlock}No indexed documents were retrieved for this question.`.trim()
      : `${noteBlock}${searchResults
          .map((item, index) => {
            const locationParts = [];
            if (item.sheetName) {
              locationParts.push(`Sheet: ${item.sheetName}`);
            }
            if (typeof item.rowNumber === "number") {
              locationParts.push(`Row: ${item.rowNumber}`);
            }
            const locationBlock = locationParts.length > 0 ? `\nLocation: ${locationParts.join(", ")}` : "";
            return `[${index + 1}] ${item.relativePath}\nScore: ${item.score.toFixed(3)}${locationBlock}\nSnippet:\n${item.text.slice(0, 1500)}`;
          })
          .join("\n\n")}`.trim();

  const effectiveSystemPrompt =
    systemPrompt?.trim() ||
    [
      "You are Filesystem RAG Chat.",
      "Answer using only the indexed filesystem context when possible.",
      "If the indexed context is insufficient, say what is missing.",
      "Mention the source file paths inline when making claims."
    ].join(" ");

  const recentHistory: Array<{ role: "assistant" | "user"; content: string }> = history.slice(-6).map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content
  }));

  const prompt = ["Indexed context:", contextBlock, "", `User question: ${userMessage}`].join("\n");
  return callProviderText({
    connection,
    model,
    secret,
    systemPrompt: effectiveSystemPrompt,
    history: recentHistory,
    prompt
  });
}

export async function selectRelevantDocuments(args: {
  connection: ProviderConnection;
  model: ProviderModel;
  secret: ProviderSecret;
  documents: IndexedDocumentRecord[];
  userMessage: string;
  maxDocuments?: number;
}): Promise<{ documentIds: string[]; reasoning?: string; rawResponse: string }> {
  const { connection, model, secret, documents, userMessage, maxDocuments = 3 } = args;
  const manifestBlock = documents
    .map((document) =>
      [
        `Document ID: ${document.documentId}`,
        `Path: ${document.relativePath}`,
        `Parser: ${document.parser}`,
        `Chunks: ${document.chunks}`,
        `Estimated tokens: ${document.tokenEstimate}`,
        `Summary: ${document.summary || "None"}`,
        document.sectionHints.length > 0 ? `Section hints: ${document.sectionHints.join(" | ")}` : "Section hints: None"
      ].join("\n")
    )
    .join("\n\n");

  const rawResponse = await callProviderText({
    connection,
    model,
    secret,
    systemPrompt: [
      "You are doing manifest-first document selection for Filesystem RAG Chat.",
      "Choose the smallest useful set of documents for answering the user's question.",
      "Return strict JSON only.",
      `Return this shape: {"document_ids":["..."],"reasoning":"..."}.`,
      `Return at most ${maxDocuments} document IDs.`,
      "Only use document IDs that appear in the manifest."
    ].join(" "),
    history: [],
    prompt: ["Manifest:", manifestBlock, "", `User question: ${userMessage}`].join("\n")
  });

  const parsed = tryParseJsonObject(rawResponse);
  const documentIds = Array.isArray(parsed?.document_ids)
    ? parsed.document_ids.filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0).slice(0, maxDocuments)
    : [];

  return {
    documentIds,
    reasoning: typeof parsed?.reasoning === "string" ? parsed.reasoning : undefined,
    rawResponse
  };
}

export async function discoverProviderModels(input: ConnectProviderInput): Promise<ProviderDiscovery> {
  switch (input.provider) {
    case "openai":
      return discoverOpenAIModels(input.apiKey || "");
    case "openai-codex":
      return discoverCodexModels();
    case "anthropic":
      return discoverAnthropicModels(input.apiKey || "");
    case "google":
      return discoverGoogleModels(input.apiKey || "");
    case "ollama":
      return discoverOllamaModels();
    case "azure-openai":
      return {
        models: [],
        warnings: ["Azure OpenAI still needs deployment-specific configuration, so automatic model discovery is not available here yet."]
      };
    default:
      throw new Error(`Unsupported provider: ${input.provider as string}`);
  }
}

export function defaultBaseUrl(provider: ProviderKind) {
  return DEFAULT_BASE_URLS[provider] || undefined;
}

export function pickDefaultChatModel(models: DiscoveredModel[]) {
  return pickPreferredModel(
    models.filter((model) => model.supportsChat),
    ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o", "gemini-2.5-flash", "claude-sonnet", "llama", "qwen", "mistral", "gemma"]
  );
}

export function pickDefaultEmbeddingModel(models: DiscoveredModel[]) {
  return pickPreferredModel(
    models.filter((model) => model.supportsEmbedding),
    ["text-embedding-3-large", "text-embedding-3-small", "gemini-embedding-001", "text-embedding-004", "nomic-embed-text", "embeddinggemma", "qwen3-embedding", "bge"]
  );
}

async function discoverOpenAIModels(apiKey: string): Promise<ProviderDiscovery> {
  const response = await fetch(joinUrl(DEFAULT_BASE_URLS.openai, "/v1/models"), {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });
  const data = await expectJson(response);
  const ids = ((data.data ?? []) as Array<{ id: string }>).map((item) => item.id).sort();
  return {
    models: ids.map((id) => ({
      provider: "openai",
      modelId: id,
      displayName: id,
      supportsChat: !id.includes("embedding") && !id.includes("moderation") && !id.includes("whisper") && !id.includes("tts"),
      supportsEmbedding: id.includes("embedding"),
      supportsVision: /vision|gpt-4o|gpt-4\.1|gpt-5/i.test(id)
    })),
    warnings: []
  };
}

async function discoverCodexModels(): Promise<ProviderDiscovery> {
  return {
    models: CODEX_DISCOVERED_MODELS.map((item) => ({
      provider: "openai-codex" as const,
      modelId: item.id,
      displayName: item.displayName,
      supportsChat: true,
      supportsEmbedding: false,
      supportsVision: true,
      metadata: JSON.stringify({
        source: "bundled-codex-catalog",
        advisoryOnly: item.id !== "chatgpt-plan-default",
        description: item.description
      })
    })),
    warnings: [
      "OpenAI Codex uses browser-based OAuth in this app and is treated as chat-only. Codex channels default to vectorless retrieval.",
      "OpenAI Codex does not currently expose a live model-list endpoint through this app. Refresh repopulates the bundled Codex-compatible catalog, and actual support still depends on what the ChatGPT Codex backend accepts for your account."
    ]
  };
}

async function discoverAnthropicModels(apiKey: string): Promise<ProviderDiscovery> {
  const response = await fetch(joinUrl(DEFAULT_BASE_URLS.anthropic, "/v1/models"), {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    }
  });
  const data = await expectJson(response);
  const ids = ((data.data ?? []) as Array<{ id: string }>).map((item) => item.id).sort();
  return {
    models: ids.map((id) => ({
      provider: "anthropic",
      modelId: id,
      displayName: id,
      supportsChat: true,
      supportsEmbedding: false,
      supportsVision: /vision|claude-3|claude-sonnet|claude-opus/i.test(id)
    })),
    warnings: ["Anthropic keys support Claude chat models. Anthropic works for vectorless channels, but vector channels still need an embedding-capable provider."]
  };
}

async function discoverGoogleModels(apiKey: string): Promise<ProviderDiscovery> {
  const response = await fetch(joinUrl(DEFAULT_BASE_URLS.google, `/v1beta/models?key=${encodeURIComponent(apiKey)}`));
  const data = await expectJson(response);
  const models = (data.models ?? []) as Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>;
  return {
    models: models
      .map((item) => ({
        provider: "google" as const,
        modelId: item.name.replace(/^models\//, ""),
        displayName: item.displayName || item.name.replace(/^models\//, ""),
        supportsChat: (item.supportedGenerationMethods ?? []).includes("generateContent"),
        supportsEmbedding: (item.supportedGenerationMethods ?? []).includes("embedContent"),
        supportsVision: /vision|flash|pro/i.test(item.name)
      }))
      .sort((left, right) => left.modelId.localeCompare(right.modelId)),
    warnings: []
  };
}

async function discoverOllamaModels(): Promise<ProviderDiscovery> {
  const response = await fetch(joinUrl(DEFAULT_BASE_URLS.ollama, "/api/tags"));
  const data = await expectJson(response);
  const ids = ((data.models ?? []) as Array<{ name: string }>).map((item) => item.name).sort();

  const details = await Promise.all(
    ids.map(async (id) => {
      try {
        const detailResponse = await fetch(joinUrl(DEFAULT_BASE_URLS.ollama, "/api/show"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ model: id })
        });
        const detail = await expectJson(detailResponse);
        const capabilities = normalizeCapabilities(detail.capabilities);
        const inferred = inferOllamaCapabilities(id, detail);
        return {
          modelId: id,
          displayName: id,
          supportsChat: capabilities.includes("completion") || capabilities.includes("chat") || inferred.supportsChat,
          supportsEmbedding:
            capabilities.includes("embedding") || capabilities.includes("embed") || inferred.supportsEmbedding,
          supportsVision: capabilities.includes("vision") || inferred.supportsVision,
          metadata: JSON.stringify({
            capabilities,
            details: detail.details ?? null
          })
        };
      } catch {
        return {
          modelId: id,
          displayName: id,
          supportsChat: false,
          supportsEmbedding: false,
          supportsVision: false,
          metadata: JSON.stringify({ discoveryError: true })
        };
      }
    })
  );

  const warnings: string[] = [];
  if (!details.some((model) => model.supportsEmbedding)) {
    warnings.push("No Ollama model with confirmed embedding capability was detected. Install a model such as nomic-embed-text, embeddinggemma, or qwen3-embedding.");
  }
  if (details.some((model) => !model.supportsChat && !model.supportsEmbedding)) {
    warnings.push("Some Ollama models could not be classified safely and were hidden from chat/embedding selectors.");
  }

  return {
    models: details.map((item) => ({
      provider: "ollama",
      modelId: item.modelId,
      displayName: item.displayName,
      supportsChat: item.supportsChat,
      supportsEmbedding: item.supportsEmbedding,
      supportsVision: item.supportsVision,
      metadata: item.metadata
    })),
    warnings
  };
}

function normalizeCapabilities(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.toLowerCase());
}

function inferOllamaCapabilities(modelId: string, detail: any) {
  const haystack = [
    modelId,
    JSON.stringify(detail.details ?? {}),
    JSON.stringify(detail.model_info ?? {}),
    JSON.stringify(detail.capabilities ?? [])
  ]
    .join(" ")
    .toLowerCase();

  const supportsEmbedding =
    /\b(embed|embedding|nomic-embed|bge|e5-|mxbai|qwen3-embedding|embeddinggemma)\b/.test(haystack);
  const supportsVision = /\b(vision|llava|moondream|bakllava|minicpm-v|qwen2\.5-vl|gemma3)\b/.test(haystack);
  const supportsChat =
    !supportsEmbedding ||
    /\b(chat|instruct|assistant|completion|generate|llama|mistral|qwen|gemma|phi|deepseek|claude)\b/.test(haystack);

  return {
    supportsChat,
    supportsEmbedding,
    supportsVision
  };
}

function pickPreferredModel(models: DiscoveredModel[], preferences: string[]) {
  if (models.length === 0) {
    return undefined;
  }
  for (const preference of preferences) {
    const exact = models.find((model) => model.modelId === preference);
    if (exact) {
      return exact;
    }
    const partial = models.find((model) => model.modelId.includes(preference));
    if (partial) {
      return partial;
    }
  }
  return models[0];
}

async function callOpenAI(args: {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  systemPrompt: string;
  history: Array<{ role: "assistant" | "user"; content: string }>;
  prompt: string;
}) {
  const response = await fetch(joinUrl(args.baseUrl || DEFAULT_BASE_URLS.openai, "/v1/chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: args.model,
      temperature: 0.2,
      messages: [{ role: "system", content: args.systemPrompt }, ...args.history, { role: "user", content: args.prompt }]
    })
  });
  const data = await expectJson(response);
  return data.choices?.[0]?.message?.content ?? "No response returned.";
}

async function callProviderText(args: {
  connection: ProviderConnection;
  model: ProviderModel;
  secret: ProviderSecret;
  systemPrompt: string;
  history: Array<{ role: "assistant" | "user"; content: string }>;
  prompt: string;
}) {
  const { connection, model, secret, systemPrompt, history, prompt } = args;
  const baseUrl = connection.baseUrl || DEFAULT_BASE_URLS[connection.provider];

  switch (connection.provider) {
    case "openai":
      return callOpenAI({
        baseUrl,
        model: model.modelId,
        apiKey: secret.apiKey,
        systemPrompt,
        history,
        prompt
      });
    case "openai-codex":
      return (
        await callCodexText({
          model: model.modelId,
          systemPrompt,
          history,
          prompt
        })
      ).text;
    case "azure-openai":
      return callAzureOpenAI({
        baseUrl: baseUrl || "",
        deployment: model.deployment || model.modelId,
        apiVersion: connection.apiVersion || "2024-10-21",
        apiKey: secret.apiKey || "",
        systemPrompt,
        history,
        prompt
      });
    case "anthropic":
      return callAnthropic({
        baseUrl: baseUrl || DEFAULT_BASE_URLS.anthropic,
        model: model.modelId,
        apiKey: secret.apiKey || "",
        systemPrompt,
        history,
        prompt
      });
    case "google":
      return callGoogle({
        baseUrl: baseUrl || DEFAULT_BASE_URLS.google,
        model: model.modelId,
        apiKey: secret.apiKey || "",
        systemPrompt,
        history,
        prompt
      });
    case "ollama":
      return callOllama({
        baseUrl,
        model: model.modelId,
        systemPrompt,
        history,
        prompt
      });
    default:
      throw new Error(`Unsupported provider: ${connection.provider as string}`);
  }
}

async function callAzureOpenAI(args: {
  baseUrl?: string;
  deployment?: string;
  apiVersion: string;
  apiKey: string;
  systemPrompt: string;
  history: Array<{ role: "assistant" | "user"; content: string }>;
  prompt: string;
}) {
  if (!args.baseUrl || !args.deployment) {
    throw new Error("Azure OpenAI requires base URL and deployment.");
  }
  const endpoint = joinUrl(
    args.baseUrl,
    `/openai/deployments/${encodeURIComponent(args.deployment)}/chat/completions?api-version=${encodeURIComponent(args.apiVersion)}`
  );
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "api-key": args.apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      temperature: 0.2,
      messages: [{ role: "system", content: args.systemPrompt }, ...args.history, { role: "user", content: args.prompt }]
    })
  });
  const data = await expectJson(response);
  return data.choices?.[0]?.message?.content ?? "No response returned.";
}

async function callAnthropic(args: {
  baseUrl: string;
  model?: string;
  apiKey: string;
  systemPrompt: string;
  history: Array<{ role: "assistant" | "user"; content: string }>;
  prompt: string;
}) {
  const response = await fetch(joinUrl(args.baseUrl, "/v1/messages"), {
    method: "POST",
    headers: {
      "x-api-key": args.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: 1400,
      system: args.systemPrompt,
      messages: [...args.history, { role: "user", content: args.prompt }]
    })
  });
  const data = await expectJson(response);
  return data.content?.map((block: { text?: string }) => block.text ?? "").join("\n") ?? "No response returned.";
}

async function callGoogle(args: {
  baseUrl: string;
  model?: string;
  apiKey: string;
  systemPrompt: string;
  history: Array<{ role: "assistant" | "user"; content: string }>;
  prompt: string;
}) {
  if (!args.model) {
    throw new Error("Google provider requires a chat model.");
  }
  const endpoint = joinUrl(args.baseUrl, `/v1beta/models/${encodeURIComponent(args.model)}:generateContent?key=${encodeURIComponent(args.apiKey)}`);
  const historyParts = args.history.map((item) => ({
    role: item.role === "assistant" ? "model" : "user",
    parts: [{ text: item.content }]
  }));
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: args.systemPrompt }]
      },
      contents: [...historyParts, { role: "user", parts: [{ text: args.prompt }] }]
    })
  });
  const data = await expectJson(response);
  return data.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("\n") ?? "No response returned.";
}

async function callOllama(args: {
  baseUrl: string;
  model?: string;
  systemPrompt: string;
  history: Array<{ role: "assistant" | "user"; content: string }>;
  prompt: string;
}) {
  const response = await fetch(joinUrl(args.baseUrl, "/api/chat"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: args.model,
      stream: false,
      messages: [{ role: "system", content: args.systemPrompt }, ...args.history, { role: "user", content: args.prompt }]
    })
  });
  const data = await expectJson(response);
  return data.message?.content ?? "No response returned.";
}

async function expectJson(response: Response) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Provider request failed (${response.status}): ${text}`);
  }
  return response.json();
}

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/$/, "")}${path}`;
}

function tryParseJsonObject(value: string) {
  const trimmed = value.trim();
  for (const candidate of [trimmed, extractCodeFenceJson(trimmed)]) {
    if (!candidate) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    try {
      return JSON.parse(trimmed.slice(braceStart, braceEnd + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function extractCodeFenceJson(value: string) {
  const match = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() ?? "";
}
