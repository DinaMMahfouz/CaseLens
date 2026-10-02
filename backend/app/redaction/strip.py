"""Layer 0: remove quoted reply chains, legal disclaimers and signatures entirely."""
from __future__ import annotations

import re
from functools import lru_cache
from typing import Any


@lru_cache(maxsize=8)
def _compile(signoffs: tuple[str, ...], quotes: tuple[str, ...]):
    return [re.compile(p) for p in signoffs], [re.compile(p) for p in quotes]


def strip_text(text: str, cfg: dict[str, Any], *, is_email: bool) -> str:
    if not text:
        return ""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    signoffs, quotes = _compile(tuple(cfg.get("signoff_lines", [])), tuple(cfg.get("quote_markers", [])))

    if is_email:
        # Quoted chains: cut at the earliest marker.
        cut = len(text)
        for pat in quotes:
            m = pat.search(text)
            if m:
                cut = min(cut, m.start())
        text = text[:cut]
        text = "\n".join(line for line in text.split("\n") if not line.lstrip().startswith(">"))

    # Legal disclaimers: drop paragraphs hitting enough disclaimer keywords.
    keywords = [k.lower() for k in cfg.get("disclaimer_keywords", [])]
    min_hits = int(cfg.get("disclaimer_min_hits", 2))
    paragraphs = re.split(r"\n\s*\n", text)
    kept = [p for p in paragraphs if sum(k in p.lower() for k in keywords) < min_hits]
    text = "\n\n".join(kept)

    if is_email:
        # Signatures: cut from the first sign-off line that is not the opening line.
        lines = text.split("\n")
        first_content = next((i for i, l in enumerate(lines) if l.strip()), 0)
        for i, line in enumerate(lines):
            if i > first_content and any(p.search(line) for p in signoffs):
                lines = lines[:i]
                break
        text = "\n".join(lines)

    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
