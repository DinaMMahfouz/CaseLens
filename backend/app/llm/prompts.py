"""Versioned prompt loading. Version = front-matter version + content hash."""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

_FRONT = re.compile(r"^---\n(.*?)\n---\n", re.S)


@dataclass(frozen=True)
class Prompt:
    rubric_id: str
    version: str          # e.g. troubleshooting.v1+3fa2b1c9
    system: str


def _read(path: Path) -> tuple[dict[str, str], str]:
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    meta: dict[str, str] = {}
    m = _FRONT.match(text)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip()
        text = text[m.end():]
    return meta, text.strip()


def load_prompts(prompt_dir: Path) -> dict[str, Prompt]:
    pre_meta, preamble = _read(prompt_dir / "_preamble.v1.md")
    prompts: dict[str, Prompt] = {}
    for path in sorted(prompt_dir.glob("*.md")):
        if path.name.startswith("_"):
            continue
        meta, body = _read(path)
        rid = meta.get("rubric_id")
        if not rid:
            continue
        system = f"{preamble}\n\n{body}\n"
        digest = hashlib.sha256(system.encode()).hexdigest()[:8]
        version = f"{meta.get('version', path.stem)}+{pre_meta.get('version', 'preamble')}+{digest}"
        # Keep the highest version per rubric (files sort lexically: x.v1 < x.v2).
        prompts[rid] = Prompt(rid, version, system)
    return prompts
