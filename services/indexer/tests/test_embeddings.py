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
