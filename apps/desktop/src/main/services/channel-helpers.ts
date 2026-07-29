import type { ChannelStatus, IndexedFileRecord, ProviderConnection, ProviderModel } from "@fschat/shared";

export const DEFAULT_CHANNEL_SYSTEM_PROMPT = [
  "You are Hello Files.",
  "Answer using the indexed filesystem context when possible.",
  "If the indexed context is insufficient, say what is missing.",
  "Mention the source file paths inline when making claims."
].join(" ");

export function labelForProvider(provider: string): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "openai-codex":
      return "OpenAI Codex";
    case "azure-openai":
      return "Azure OpenAI";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google Gemini";
    case "ollama":
      return "Ollama";
    default:
      return provider;
  }
}

export function isInvalidIndexError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("Unsupported index version") || error.message.includes("Index manifest not found");
}

export function isMissingProviderConfigurationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("Provider model not found") ||
    error.message.includes("Provider connection not found") ||
    error.message.includes("Credentials missing for provider connection")
  );
}

export function buildEmbeddingModelKey(connection: ProviderConnection, model: ProviderModel): string {
  return [connection.provider, connection.baseUrl || "", connection.apiVersion || "", model.deployment || "", model.modelId].join("|");
}

export function normalizeChannelSystemPrompt(value?: string | null, fallback = DEFAULT_CHANNEL_SYSTEM_PROMPT): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

export function resolveThreadTitle(value: string | null | undefined, sessionNumber: number): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : `Session ${sessionNumber}`;
}

export function deriveChannelStatusFromFiles(files: IndexedFileRecord[]): Exclude<ChannelStatus, "indexing"> {
  if (files.some((file) => file.status === "indexed")) {
    return "ready";
  }
  if (files.some((file) => file.status === "failed")) {
    return "error";
  }
  return "idle";
}

export function deriveCancelledChannelStatus(files: IndexedFileRecord[]): Exclude<ChannelStatus, "indexing"> {
  if (files.some((file) => file.status === "indexed")) {
    return "stale";
  }
  if (files.some((file) => file.status === "failed")) {
    return "error";
  }
  return "idle";
}

export function providerSupportsMultimodalInput(provider: ProviderConnection["provider"]): boolean {
  return ["openai", "openai-codex", "azure-openai", "anthropic", "google", "ollama"].includes(provider);
}