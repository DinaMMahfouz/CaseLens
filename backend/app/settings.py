"""Configuration loading and startup guardrails.

All business rules, thresholds and weights live in /config/*.yaml. Secrets come from
environment variables only.
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(os.environ.get("CASEQA_ROOT", Path(__file__).resolve().parents[2]))
_DEV_PSEUDONYM_KEY = "synthetic-dev-only-pseudonym-key"


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader (KEY=VALUE lines). Real environment variables win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        if value:
            os.environ.setdefault(key.strip(), value)


_load_dotenv(ROOT / ".env")


class ConfigError(RuntimeError):
    """Raised when configuration violates a guardrail. The app must not start."""


@dataclass(frozen=True)
class Settings:
    root: Path
    app: dict[str, Any]
    mapping: dict[str, Any]
    rules: dict[str, Any]
    scoring: dict[str, Any]
    review: dict[str, Any]
    redaction: dict[str, Any]
    database_url: str
    pseudonym_key: bytes = field(repr=False)

    @property
    def redaction_enabled(self) -> bool:
        return bool(self.app.get("redaction", {}).get("enabled", True))

    @property
    def synthetic(self) -> bool:
        return bool(self.app.get("data_source", {}).get("synthetic", False))

    @property
    def config_hash(self) -> str:
        blob = json.dumps(
            [self.mapping, self.rules, self.scoring, self.review, self.redaction,
             {k: v for k, v in self.app.items() if k != "llm"}],
            sort_keys=True, default=str,
        )
        return hashlib.sha256(blob.encode()).hexdigest()[:12]

    def path(self, rel: str) -> Path:
        p = Path(rel)
        return p if p.is_absolute() else self.root / p

    def public_view(self) -> dict[str, Any]:
        """Non-secret effective config for the API."""
        llm = dict(self.app.get("llm", {}))
        return {
            "app": {**{k: v for k, v in self.app.items() if k != "llm"}, "llm": llm},
            "rules": self.rules,
            "scoring": self.scoring,
            "review": self.review,
            "config_hash": self.config_hash,
        }


def _load_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise ConfigError(f"missing config file: {path.name}")
    with path.open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def load_settings(config_dir: Path | None = None, **overrides: Any) -> Settings:
    cdir = config_dir or ROOT / "config"
    parts = {
        name: _load_yaml(cdir / f"{name}.yaml")
        for name in ("app", "mapping", "rules", "scoring", "review", "redaction")
    }
    for key, value in overrides.items():
        parts[key] = value
    db_url = os.environ.get("DATABASE_URL", f"sqlite:///{(ROOT / 'var' / 'caseqa.db').as_posix()}")
    key = os.environ.get("CASEQA_PSEUDONYM_KEY", "")
    synthetic = bool(parts["app"].get("data_source", {}).get("synthetic", False))
    if not key:
        if not synthetic:
            raise ConfigError("CASEQA_PSEUDONYM_KEY must be set for non-synthetic data")
        key = _DEV_PSEUDONYM_KEY
    settings = Settings(root=ROOT, database_url=db_url, pseudonym_key=key.encode(), **parts)
    validate_startup(settings)
    return settings


def validate_startup(settings: Settings) -> None:
    """Fail closed: redaction may only be disabled for synthetic data sources."""
    if not settings.redaction_enabled and not settings.synthetic:
        raise ConfigError(
            "Refusing to start: redaction is disabled but the data source is not marked synthetic."
        )
    weights = settings.scoring.get("weights", {})
    if not weights or any(float(w) < 0 for w in weights.values()):
        raise ConfigError("scoring.weights must be non-empty and non-negative")
    targets = settings.rules.get("slo", {}).get("initial_response", {}).get("targets_minutes", {})
    for sev in (1, 2, 3, 4):
        if sev not in targets:
            raise ConfigError(f"rules.slo.initial_response.targets_minutes missing severity {sev}")


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = load_settings()
    return _settings


def set_settings(settings: Settings | None) -> None:
    global _settings
    _settings = settings
