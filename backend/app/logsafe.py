"""PII-safe logging.

Application code logs through `log_event`, which only accepts whitelisted field names
and scalar values that look like identifiers, stages, statuses, counts or timings.
Anything else is replaced with "<dropped>". Free-form messages are not accepted.
"""
from __future__ import annotations

import logging
import re
from typing import Any

_LOGGER = logging.getLogger("caseqa")
_SAFE_STR = re.compile(r"^[A-Za-z0-9_.:/\-{}]{0,64}$")
ALLOWED_FIELDS = {
    "run_id", "case_id", "case_number", "audit_id", "upload_id", "stage", "status",
    "state", "duration_ms", "count", "total", "processed", "failed", "dimension",
    "run_index", "retries", "provider", "model", "error_kind", "detector", "method",
    "path", "status_code", "hits", "attempt", "level", "reason",
}


def _clean(value: Any) -> Any:
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str) and _SAFE_STR.match(value):
        return value
    return "<dropped>"


def log_event(event: str, level: int = logging.INFO, **fields: Any) -> None:
    if not _SAFE_STR.match(event):
        event = "<dropped>"
    parts = [f"event={event}"]
    for key in sorted(fields):
        if key not in ALLOWED_FIELDS:
            continue
        parts.append(f"{key}={_clean(fields[key])}")
    _LOGGER.log(level, " ".join(parts))


def configure_logging(level: int = logging.INFO) -> None:
    root = logging.getLogger()
    if not any(getattr(h, "_caseqa", False) for h in root.handlers):
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        handler._caseqa = True  # type: ignore[attr-defined]
        root.addHandler(handler)
    root.setLevel(level)
    # Third-party libraries could echo payloads at DEBUG; keep them quiet.
    for noisy in ("presidio-analyzer", "presidio_analyzer", "httpx", "httpcore", "anthropic",
                  "urllib3", "multipart", "uvicorn.access", "spacy"):
        logging.getLogger(noisy).setLevel(logging.ERROR if noisy.startswith("presidio") else logging.WARNING)
