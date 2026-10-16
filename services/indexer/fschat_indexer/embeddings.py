from __future__ import annotations

import json
import re
import socket
import time
from typing import Callable, Iterable
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request


OPENROUTER_BASE_URL = "https://openrouter.ai/api"
DEFAULT_TIMEOUT_SECONDS = 60
QUERY_TIMEOUT_SECONDS = 30
MAX_RETRIES = 2
RETRY_BASE_DELAY_SECONDS = 1.0
RETRYABLE_STATUS_CODES = {408, 429, 500, 502, 503, 504}

# Indirection so tests can avoid real sleeps.
_sleep = time.sleep
_monotonic = time.monotonic

# OpenRouter's free (":free") models allow 20 requests a minute, with or without credits. Space
# requests out instead of hitting the limit and having to wait for the window to reset.
FREE_MODEL_MIN_INTERVAL_SECONDS = 3.2
_last_free_model_request = 0.0
MAX_RATE_LIMIT_WAIT_SECONDS = 65.0

# Called with a short human-readable line before each retry, so the UI can say "rate limited,
# retrying in 20 s" instead of looking frozen. Set by the build while it embeds.
retry_notifier: Callable[[str], None] | None = None

# A daily quota doesn't clear in seconds, so retrying only makes the wait longer.
_DAILY_LIMIT = re.compile(r"per[- ]day|daily", re.IGNORECASE)


class EmbeddingError(RuntimeError):
    """Raised when the embedding provider cannot be reached or rejects the request."""


def pace_free_model(provider: dict) -> None:
    global _last_free_model_request
    if provider.get("provider") != "openrouter" or not str(provider.get("model") or "").endswith(":free"):
        return
    wait = _last_free_model_request + FREE_MODEL_MIN_INTERVAL_SECONDS - _monotonic()
    if wait > 0:
        _sleep(wait)
    _last_free_model_request = _monotonic()


def embed_texts(provider: dict, texts: list[str], timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS) -> list[list[float]]:
    pace_free_model(provider)
    kind = provider.get("provider")
    if kind == "openai":
        return openai_embeddings(provider, texts, timeout_seconds=timeout_seconds)
    if kind == "openrouter":
        # OpenRouter speaks the OpenAI embeddings protocol at /api/v1/embeddings.
        return openai_embeddings(provider, texts, timeout_seconds=timeout_seconds, default_base_url=OPENROUTER_BASE_URL)
    if kind == "azure-openai":
        return azure_openai_embeddings(provider, texts, timeout_seconds=timeout_seconds)
    if kind == "google":
        return google_embeddings(provider, texts, timeout_seconds=timeout_seconds)
    if kind == "ollama":
        return ollama_embeddings(provider, texts, timeout_seconds=timeout_seconds)
    raise ValueError(f"Provider '{kind}' is not supported for embeddings.")


def embed_query(provider: dict, text: str, timeout_seconds: float = QUERY_TIMEOUT_SECONDS) -> list[float]:
    return embed_texts(provider, [text], timeout_seconds=timeout_seconds)[0]


def openai_embeddings(
    provider: dict,
    texts: list[str],
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    default_base_url: str = "https://api.openai.com",
) -> list[list[float]]:
    url = join_url(provider.get("baseUrl") or default_base_url, "/v1/embeddings")
    payload = {"model": provider.get("model"), "input": texts}
    headers = {"Authorization": f"Bearer {provider.get('apiKey', '')}", "Content-Type": "application/json"}
    data = post_json(url, headers, payload, timeout_seconds=timeout_seconds)
    items = data["data"]
    if all(isinstance(item.get("index"), int) for item in items):
        items = sorted(items, key=lambda item: item["index"])
    return [item["embedding"] for item in items]


def azure_openai_embeddings(provider: dict, texts: list[str], timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS) -> list[list[float]]:
    base_url = provider.get("baseUrl")
    deployment = provider.get("deployment") or provider.get("model")
    if not base_url or not deployment:
        raise ValueError("Azure OpenAI embeddings require baseUrl and deployment/model.")
    api_version = provider.get("apiVersion") or "2024-10-21"
    url = join_url(base_url, f"/openai/deployments/{deployment}/embeddings?api-version={api_version}")
    headers = {"api-key": provider.get("apiKey", ""), "Content-Type": "application/json"}
    data = post_json(url, headers, {"input": texts}, timeout_seconds=timeout_seconds)
    return [item["embedding"] for item in data["data"]]


def google_embeddings(provider: dict, texts: list[str], timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS) -> list[list[float]]:
    model = provider.get("model")
    api_key = provider.get("apiKey")
    if not model:
        raise ValueError("Google embeddings require a model.")
    url = join_url(provider.get("baseUrl") or "https://generativelanguage.googleapis.com", f"/v1beta/models/{model}:batchEmbedContents?key={api_key}")
    payload = {"requests": [{"model": f"models/{model}", "content": {"parts": [{"text": text}]}} for text in texts]}
    data = post_json(url, {"Content-Type": "application/json"}, payload, timeout_seconds=timeout_seconds)
    return [item["values"] for item in data["embeddings"]]


def ollama_embeddings(provider: dict, texts: list[str], timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS) -> list[list[float]]:
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


def batched(items: Iterable[str], size: int) -> Iterable[list[str]]:
    batch: list[str] = []
    for item in items:
        batch.append(item)
        if len(batch) == size:
            yield batch
            batch = []
    if batch:
        yield batch


def post_json(
    url: str,
    headers: dict,
    payload: dict,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    max_retries: int = MAX_RETRIES,
) -> dict:
    data = json.dumps(payload).encode("utf-8")
    host = describe_endpoint(url)
    attempt = 0
    while True:
        req = urllib_request.Request(url, data=data, headers=headers, method="POST")
        retry_after: float | None = None
        try:
            with urllib_request.urlopen(req, timeout=timeout_seconds) as response:
                body = response.read().decode("utf-8")
            try:
                return json.loads(body)
            except json.JSONDecodeError as exc:
                raise EmbeddingError(f"Embedding provider at {host} returned invalid JSON.") from exc
        except urllib_error.HTTPError as exc:
            detail = read_error_detail(exc)
            message = f"Embedding request to {host} failed with HTTP {exc.code}{f': {detail}' if detail else ''}."
            if exc.code not in RETRYABLE_STATUS_CODES or attempt >= max_retries:
                raise EmbeddingError(message) from None
            if exc.code == 429 and _DAILY_LIMIT.search(detail):
                raise EmbeddingError(message) from None
            problem = "is rate limiting requests" if exc.code == 429 else f"returned HTTP {exc.code}"
            headers = exc.headers or {}
            retry_after = parse_retry_after(headers.get("Retry-After"))
            if retry_after is None:
                retry_after = parse_rate_limit_reset(headers.get("X-RateLimit-Reset"))
        except (urllib_error.URLError, socket.timeout, TimeoutError, ConnectionError) as exc:
            reason = getattr(exc, "reason", None) or exc
            if isinstance(reason, (socket.timeout, TimeoutError)):
                message = f"Embedding request to {host} timed out after {timeout_seconds:g}s."
                problem = f"timed out after {timeout_seconds:g}s"
            else:
                message = f"Could not reach embedding provider at {host}: {reason}."
                problem = "could not be reached"
            if attempt >= max_retries:
                raise EmbeddingError(message) from None
        delay = RETRY_BASE_DELAY_SECONDS * (2**attempt)
        if retry_after is not None:
            delay = max(delay, min(retry_after, MAX_RATE_LIMIT_WAIT_SECONDS))
        if retry_notifier is not None:
            retry_notifier(f"{host} {problem}. Retrying in {delay:g}s (attempt {attempt + 2} of {max_retries + 1})...")
        _sleep(delay)
        attempt += 1


def describe_endpoint(url: str) -> str:
    """Scheme + host only, so API keys in query strings never reach error messages."""
    parsed = urllib_parse.urlsplit(url)
    return f"{parsed.scheme}://{parsed.netloc}" if parsed.netloc else "the embedding endpoint"


def read_error_detail(exc: urllib_error.HTTPError, limit: int = 300) -> str:
    try:
        body = exc.read().decode("utf-8", errors="ignore")
    except Exception:
        return ""
    try:
        parsed = json.loads(body)
        error = parsed.get("error") if isinstance(parsed, dict) else None
        if isinstance(error, dict) and error.get("message"):
            body = str(error["message"])
        elif isinstance(error, str):
            body = error
    except Exception:
        pass
    body = " ".join(body.split())
    return body[:limit]


def parse_rate_limit_reset(value: str | None) -> float | None:
    """Seconds until a rate-limit window resets, from an X-RateLimit-Reset header (epoch milliseconds)."""
    if not value:
        return None
    try:
        return max(0.0, float(value) / 1000.0 - time.time())
    except ValueError:
        return None


def parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


def join_url(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}{path}"
