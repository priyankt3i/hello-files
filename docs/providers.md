# Providers

Hello Files separates provider connections from channel configuration.

A provider connection stores connection-level settings such as provider type, base URL, API version, and credentials. A channel then selects a chat model and an embedding model from that connection.

## Currently Supported Providers

- OpenAI
- Azure OpenAI
- Anthropic
- Google Gemini
- Ollama

## Important Behavior

- Chat and embedding models must come from the same provider connection.
- Anthropic is chat-only in the current app flow. It does not provide embeddings here.
- Azure OpenAI still requires deployment-specific setup and does not support automatic model discovery yet.
- Ollama is the easiest local-first option, but indexing speed depends heavily on the installed embedding model.

## Provider Discovery

Provider model discovery is handled in:

- `apps/desktop/src/main/providers/client.ts`

The discovery behavior is provider-specific:

- OpenAI: discovered from `/v1/models`
- Anthropic: discovered from `/v1/models`
- Google: discovered from the Gemini models endpoint
- Ollama: discovered from local model tags and then inspected further
- Azure OpenAI: manual/deployment-driven for now

## Default Model Selection

The app tries to pick sensible defaults after discovery:

- chat defaults prefer models like `gpt-5`, `gpt-4.1`, `gpt-4o`, `gemini`, `claude`, `llama`, `qwen`
- embedding defaults prefer models like `text-embedding-3-large`, `text-embedding-3-small`, `gemini-embedding-001`, `nomic-embed-text`, `embeddinggemma`, `qwen3-embedding`

These are heuristics, not guarantees.

## Contributor Notes

When changing provider logic:

- keep chat and embedding capability checks explicit
- avoid breaking stored provider connections silently
- document any provider-specific limitation in `README.md` and this file
