"""Pluggable LLM providers. Each provider talks ONLY to its configured endpoint."""
from __future__ import annotations

import os
from abc import ABC, abstractmethod
from typing import Any, Optional


class ProviderError(RuntimeError):
    """Transport/API failure (not an invalid-output failure)."""


class LLMProvider(ABC):
    name: str = "base"
    model: str = ""
    # Effective sampling temperature recorded with every audit. None = model default
    # (some current models reject an explicit temperature).
    effective_temperature: Optional[float] = 0.0

    @abstractmethod
    def complete(self, system: str, user: str) -> str:
        """Return the model's raw text output."""


class AnthropicProvider(LLMProvider):
    name = "anthropic"

    def __init__(self, cfg: dict[str, Any], llm_cfg: dict[str, Any]):
        import anthropic

        self.model = cfg.get("model", "claude-sonnet-5-5")
        self.max_tokens = int(llm_cfg.get("max_tokens", 2000))
        self.effort = cfg.get("effort")
        self.refusal_fallback = bool(cfg.get("refusal_fallback", True))
        # Claude 4.7+/5.x models reject non-default sampling parameters, so temperature
        # is omitted for them and recorded as the model default.
        self.send_temperature = bool(cfg.get("send_temperature", False))
        self.effective_temperature = float(llm_cfg.get("temperature", 0)) if self.send_temperature else None
        kwargs: dict[str, Any] = {"timeout": float(llm_cfg.get("timeout_seconds", 120)), "max_retries": 2}
        if os.environ.get("ANTHROPIC_BASE_URL"):
            kwargs["base_url"] = os.environ["ANTHROPIC_BASE_URL"]
        self._anthropic = anthropic
        self.client = anthropic.Anthropic(**kwargs)

    def complete(self, system: str, user: str) -> str:
        params: dict[str, Any] = {
            "model": self.model, "max_tokens": self.max_tokens, "system": system,
            "messages": [{"role": "user", "content": user}],
        }
        if self.send_temperature:
            params["temperature"] = self.effective_temperature
        extra: dict[str, Any] = {}
        if self.effort:
            extra["output_config"] = {"effort": self.effort}
        try:
            if self.refusal_fallback:
                extra["fallbacks"] = "default"
                resp = self.client.beta.messages.create(
                    betas=["server-side-fallback-2026-07-01"], extra_body=extra, **params)
            else:
                resp = self.client.messages.create(extra_body=extra or None, **params)
        except self._anthropic.APIError as exc:  # never include payload in the error
            raise ProviderError(type(exc).__name__) from None
        if resp.stop_reason == "refusal":
            return ""   # treated as invalid output -> retry, then EVAL_FAILED
        return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")


class OpenAICompatibleProvider(LLMProvider):
    name = "openai_compatible"

    def __init__(self, cfg: dict[str, Any], llm_cfg: dict[str, Any]):
        import httpx

        self.model = cfg.get("model", "")
        self.base_url = os.environ.get("OPENAI_BASE_URL", cfg.get("base_url", "")).rstrip("/")
        self.effective_temperature = float(llm_cfg.get("temperature", 0))
        self.max_tokens = int(llm_cfg.get("max_tokens", 2000))
        self.client = httpx.Client(timeout=float(llm_cfg.get("timeout_seconds", 120)))
        self.key = os.environ.get("OPENAI_API_KEY", "")

    def complete(self, system: str, user: str) -> str:
        try:
            r = self.client.post(
                f"{self.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self.key}"},
                json={"model": self.model, "temperature": self.effective_temperature,
                      "max_tokens": self.max_tokens, "response_format": {"type": "json_object"},
                      "messages": [{"role": "system", "content": system},
                                   {"role": "user", "content": user}]},
            )
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"] or ""
        except Exception as exc:
            raise ProviderError(type(exc).__name__) from None


class OllamaProvider(LLMProvider):
    name = "ollama"

    def __init__(self, cfg: dict[str, Any], llm_cfg: dict[str, Any]):
        import httpx

        self.model = cfg.get("model", "llama3.1:8b")
        self.base_url = os.environ.get("OLLAMA_BASE_URL", cfg.get("base_url", "http://localhost:11434")).rstrip("/")
        self.effective_temperature = float(llm_cfg.get("temperature", 0))
        self.client = httpx.Client(timeout=float(llm_cfg.get("timeout_seconds", 120)))

    def complete(self, system: str, user: str) -> str:
        try:
            r = self.client.post(f"{self.base_url}/api/chat", json={
                "model": self.model, "stream": False, "format": "json",
                "options": {"temperature": self.effective_temperature, "seed": 0},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            })
            r.raise_for_status()
            return r.json()["message"]["content"] or ""
        except Exception as exc:
            raise ProviderError(type(exc).__name__) from None


def build_provider(app_cfg: dict[str, Any]) -> LLMProvider:
    llm = app_cfg.get("llm", {})
    kind = llm.get("provider", "mock")
    if kind == "mock":
        from app.llm.mock import MockProvider
        return MockProvider()
    if kind == "anthropic":
        return AnthropicProvider(llm.get("anthropic", {}), llm)
    if kind == "openai_compatible":
        return OpenAICompatibleProvider(llm.get("openai_compatible", {}), llm)
    if kind == "ollama":
        return OllamaProvider(llm.get("ollama", {}), llm)
    raise ValueError(f"unknown llm provider: {kind}")
