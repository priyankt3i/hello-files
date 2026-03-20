from __future__ import annotations

import json
from typing import Iterable
from urllib import request as urllib_request


def embed_texts(provider: dict, texts: list[str], timeout_seconds: int | None = 120) -> list[list[float]]:
    kind = provider.get("provider")
    if kind == "openai":
        return openai_embeddings(provider, texts, timeout_seconds=timeout_seconds)
    if kind == "azure-openai":
        return azure_openai_embeddings(provider, texts, timeout_seconds=timeout_seconds)
    if kind == "google":
        return google_embeddings(provider, texts, timeout_seconds=timeout_seconds)
    if kind == "ollama":
        return ollama_embeddings(provider, texts, timeout_seconds=timeout_seconds)
    raise ValueError(f"Provider '{kind}' is not supported for embeddings.")


def embed_query(provider: dict, text: str, timeout_seconds: int | None = 120) -> list[float]:
    return embed_texts(provider, [text], timeout_seconds=timeout_seconds)[0]


def openai_embeddings(provider: dict, texts: list[str], timeout_seconds: int | None = 180) -> list[list[float]]:
    url = join_url(provider.get("baseUrl") or "https://api.openai.com", "/v1/embeddings")
    payload = {"model": provider.get("model"), "input": texts}
    headers = {"Authorization": f"Bearer {provider.get('apiKey', '')}", "Content-Type": "application/json"}
    data = post_json(url, headers, payload, timeout_seconds=timeout_seconds)
    return [item["embedding"] for item in data["data"]]


def azure_openai_embeddings(provider: dict, texts: list[str], timeout_seconds: int | None = 180) -> list[list[float]]:
    base_url = provider.get("baseUrl")
    deployment = provider.get("deployment") or provider.get("model")
    if not base_url or not deployment:
        raise ValueError("Azure OpenAI embeddings require baseUrl and deployment/model.")
    api_version = provider.get("apiVersion") or "2024-10-21"
    url = join_url(base_url, f"/openai/deployments/{deployment}/embeddings?api-version={api_version}")
    headers = {"api-key": provider.get("apiKey", ""), "Content-Type": "application/json"}
    data = post_json(url, headers, {"input": texts}, timeout_seconds=timeout_seconds)
    return [item["embedding"] for item in data["data"]]


def google_embeddings(provider: dict, texts: list[str], timeout_seconds: int | None = 180) -> list[list[float]]:
    model = provider.get("model")
    api_key = provider.get("apiKey")
    if not model:
        raise ValueError("Google embeddings require a model.")
    url = join_url(provider.get("baseUrl") or "https://generativelanguage.googleapis.com", f"/v1beta/models/{model}:batchEmbedContents?key={api_key}")
    payload = {"requests": [{"model": f"models/{model}", "content": {"parts": [{"text": text}]}} for text in texts]}
    data = post_json(url, {"Content-Type": "application/json"}, payload, timeout_seconds=timeout_seconds)
    return [item["values"] for item in data["embeddings"]]


def ollama_embeddings(provider: dict, texts: list[str], timeout_seconds: int | None = 900) -> list[list[float]]:
    model = provider.get("model")
    if not model:
        raise ValueError("Ollama embeddings require a model.")
    url = join_url(provider.get("baseUrl") or "http://127.0.0.1:11434", "/api/embed")
    data = post_json(
        url,
        {"Content-Type": "application/json"},
        {"model": model, "input": texts},
        timeout_seconds=timeout_seconds,
    )
    embeddings = data.get("embeddings")
    if isinstance(embeddings, list) and embeddings and isinstance(embeddings[0], list):
        return embeddings
    if isinstance(embeddings, list):
        return [embeddings]
    raise ValueError("Ollama embedding response did not contain embeddings.")


def cosine_similarity(left: list[float], right: list[float]) -> float:
    numerator = sum(a * b for a, b in zip(left, right))
    left_norm = sum(a * a for a in left) ** 0.5
    right_norm = sum(b * b for b in right) ** 0.5
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return numerator / (left_norm * right_norm)


def batched(items: Iterable[str], size: int) -> Iterable[list[str]]:
    batch: list[str] = []
    for item in items:
        batch.append(item)
        if len(batch) == size:
            yield batch
            batch = []
    if batch:
        yield batch


def post_json(url: str, headers: dict, payload: dict, timeout_seconds: int | None = 120) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib_request.Request(url, data=data, headers=headers, method="POST")
    if timeout_seconds is None:
        response = urllib_request.urlopen(req)
    else:
        response = urllib_request.urlopen(req, timeout=timeout_seconds)
    with response:
        body = response.read().decode("utf-8")
        return json.loads(body)


def join_url(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}{path}"
