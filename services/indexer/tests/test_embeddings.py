from __future__ import annotations

import io
import json
from urllib import error as urllib_error

import pytest

import embeddings


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def test_retries_on_5xx_then_succeeds(monkeypatch):
    attempts = []
    sleeps = []

    def fake_urlopen(req, timeout):
        attempts.append(timeout)
        if len(attempts) < 3:
            raise urllib_error.HTTPError(req.full_url, 503, "busy", {}, io.BytesIO(b"{}"))
        return FakeResponse(json.dumps({"data": [{"embedding": [1.0, 0.0]}]}).encode())

    monkeypatch.setattr(embeddings.urllib_request, "urlopen", fake_urlopen)
    monkeypatch.setattr(embeddings, "_sleep", sleeps.append)
    result = embeddings.embed_texts({"provider": "openai", "model": "m", "apiKey": "k"}, ["hi"])
    assert result == [[1.0, 0.0]]
    assert attempts == [60, 60, 60]
    assert sleeps == [1.0, 2.0]


def test_does_not_retry_client_errors_and_hides_key(monkeypatch):
    attempts = []

    def fake_urlopen(req, timeout):
        attempts.append(1)
        body = io.BytesIO(json.dumps({"error": {"message": "API key not valid"}}).encode())
        raise urllib_error.HTTPError(req.full_url, 400, "bad", {}, body)

    monkeypatch.setattr(embeddings.urllib_request, "urlopen", fake_urlopen)
    with pytest.raises(embeddings.EmbeddingError) as info:
        embeddings.embed_texts({"provider": "google", "model": "m", "apiKey": "SECRETKEY"}, ["hi"])
    assert len(attempts) == 1
    assert "HTTP 400" in str(info.value) and "API key not valid" in str(info.value)
    assert "SECRETKEY" not in str(info.value)


def test_timeout_message_and_query_timeout(monkeypatch):
    seen = []

    def fake_urlopen(req, timeout):
        seen.append(timeout)
        raise urllib_error.URLError(TimeoutError("timed out"))

    monkeypatch.setattr(embeddings.urllib_request, "urlopen", fake_urlopen)
    monkeypatch.setattr(embeddings, "_sleep", lambda delay: None)
    with pytest.raises(embeddings.EmbeddingError, match="timed out after 30s"):
        embeddings.embed_query({"provider": "ollama", "model": "m"}, "hi")
    assert seen == [30, 30, 30]


def test_openrouter_embeddings_use_the_openai_protocol(monkeypatch):
    seen = {}

    def fake_urlopen(req, timeout):
        seen["url"] = req.full_url
        seen["auth"] = req.get_header("Authorization")
        seen["body"] = json.loads(req.data.decode())
        # Out-of-order items must be put back in input order.
        data = [{"index": 1, "embedding": [0.0, 1.0]}, {"index": 0, "embedding": [1.0, 0.0]}]
        return FakeResponse(json.dumps({"data": data}).encode())

    monkeypatch.setattr(embeddings.urllib_request, "urlopen", fake_urlopen)
    provider = {"provider": "openrouter", "model": "openai/text-embedding-3-small", "apiKey": "sk-or-1"}
    assert embeddings.embed_texts(provider, ["a", "b"]) == [[1.0, 0.0], [0.0, 1.0]]
    assert seen["url"] == "https://openrouter.ai/api/v1/embeddings"
    assert seen["auth"] == "Bearer sk-or-1"
    assert seen["body"] == {"model": "openai/text-embedding-3-small", "input": ["a", "b"]}


def test_retries_are_announced_so_the_ui_is_not_silent(monkeypatch):
    attempts = []
    notes = []

    def fake_urlopen(req, timeout):
        attempts.append(1)
        if len(attempts) < 3:
            raise urllib_error.HTTPError(req.full_url, 429, "slow down", {}, io.BytesIO(b"{}"))
        return FakeResponse(json.dumps({"data": [{"embedding": [1.0]}]}).encode())

    monkeypatch.setattr(embeddings.urllib_request, "urlopen", fake_urlopen)
    monkeypatch.setattr(embeddings, "_sleep", lambda seconds: None)
    monkeypatch.setattr(embeddings, "retry_notifier", notes.append)
    assert embeddings.embed_texts({"provider": "openai", "model": "m", "apiKey": "k"}, ["hi"]) == [[1.0]]
    assert len(notes) == 2
    assert "rate limiting" in notes[0] and "Retrying in 1s (attempt 2 of 3)" in notes[0]
    assert "attempt 3 of 3" in notes[1]


def test_daily_quota_is_not_retried(monkeypatch):
    attempts = []

    def fake_urlopen(req, timeout):
        attempts.append(1)
        body = io.BytesIO(json.dumps({"error": {"message": "Rate limit exceeded: free-models-per-day"}}).encode())
        raise urllib_error.HTTPError(req.full_url, 429, "limit", {}, body)

    monkeypatch.setattr(embeddings.urllib_request, "urlopen", fake_urlopen)
    monkeypatch.setattr(embeddings, "_sleep", lambda seconds: pytest.fail("must not wait for a daily quota"))
    with pytest.raises(embeddings.EmbeddingError, match="free-models-per-day"):
        embeddings.embed_texts({"provider": "openrouter", "model": "m", "apiKey": "k"}, ["hi"])
    assert len(attempts) == 1


def test_waits_for_the_rate_limit_window_to_reset(monkeypatch):
    import time as real_time

    attempts = []
    sleeps = []

    def fake_urlopen(req, timeout):
        attempts.append(1)
        if len(attempts) == 1:
            reset_ms = str(int((real_time.time() + 20) * 1000))
            raise urllib_error.HTTPError(req.full_url, 429, "limit", {"X-RateLimit-Reset": reset_ms}, io.BytesIO(b"{}"))
        return FakeResponse(json.dumps({"data": [{"embedding": [1.0]}]}).encode())

    monkeypatch.setattr(embeddings.urllib_request, "urlopen", fake_urlopen)
    monkeypatch.setattr(embeddings, "_sleep", sleeps.append)
    assert embeddings.embed_texts({"provider": "openai", "model": "m", "apiKey": "k"}, ["hi"]) == [[1.0]]
    assert len(sleeps) == 1 and 15 <= sleeps[0] <= 21  # the window, not the default 1 s


def test_free_openrouter_models_are_paced_below_20_requests_a_minute(monkeypatch):
    clock = [100.0]
    sleeps = []
    monkeypatch.setattr(embeddings, "_monotonic", lambda: clock[0])
    monkeypatch.setattr(embeddings, "_sleep", lambda seconds: (sleeps.append(seconds), clock.__setitem__(0, clock[0] + seconds)))
    monkeypatch.setattr(embeddings, "_last_free_model_request", 0.0)
    monkeypatch.setattr(
        embeddings.urllib_request,
        "urlopen",
        lambda req, timeout: FakeResponse(json.dumps({"data": [{"embedding": [1.0]}]}).encode()),
    )
    free = {"provider": "openrouter", "model": "nvidia/nemotron-3-embed-1b:free", "apiKey": "k"}
    for _ in range(3):
        embeddings.embed_texts(free, ["hi"])
    assert len(sleeps) == 2 and all(3.0 <= seconds <= 3.21 for seconds in sleeps)  # first call is immediate

    sleeps.clear()
    paid = {"provider": "openrouter", "model": "openai/text-embedding-3-small", "apiKey": "k"}
    for _ in range(3):
        embeddings.embed_texts(paid, ["hi"])
    assert sleeps == []
