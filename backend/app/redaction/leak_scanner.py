"""Independent post-redaction leak scanner. Fail closed.

Deliberately does NOT reuse the redaction regexes: it uses its own, simpler detectors so
that a bug in the redaction layer is caught here rather than mirrored. Results contain
detector names and locations only, never the matched value.
"""
from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from typing import Iterable

_TOKEN = re.compile(r"\[[A-Z_]+_\d+\]")
_COMMON_TLDS = ("com|net|org|local|corp|internal|lan|intra|io|co|uk|de|fr|nl|sa|ae|eg|in|us|ca|au|"
                "info|biz|edu|gov|mil|cloud|app|dev|ad|int|eu|ch|se|no|jp|cn|sg|qa|kw|bh|om")

DETECTORS: list[tuple[str, re.Pattern]] = [
    ("email", re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")),
    ("ipv4", re.compile(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b")),
    ("mac", re.compile(r"\b[0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5}\b")),
    ("pem", re.compile(r"-----BEGIN ")),
    ("unc_path", re.compile(r"\\\\[\w.$-]+\\")),
    ("user_path", re.compile(r"(?i)(?:[a-z]:\\users\\\w|/home/\w|/Users/\w)")),
    ("ldap_dn", re.compile(r"(?i)\b(?:cn|ou|dc|uid)=\w[^,\n]*,\s*(?:cn|ou|dc|o)=")),
    ("url", re.compile(r"(?i)\b(?:https?|ftps?|ldaps?)://(?!\[)")),
    ("phone", re.compile(r"\+\d[\d\s().-]{7,}\d")),
    ("local_phone", re.compile(r"(?<![\w.-])0\d{2,4}[\s-]\d{3,4}[\s-]\d{3,4}(?![\w-])(?!\.\d)")),
    ("session_kv", re.compile(r"(?i)\b(?:sess(?:ion)?(?:[_-]?id)?|jsessionid|cookie)\s*[:=]\s*(?!\[)\S")),
    ("long_number", re.compile(r"(?<![\w.-])\d{9,}(?![\w-])(?!\.\d)")),
    ("secret_kv", re.compile(r"(?i)\b(?:password|passwd|pwd|secret|api[_-]?key|client[_-]?secret)\s*[:=]\s*(?!\[)\S")),
    ("fqdn", re.compile(rf"(?i)\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:{_COMMON_TLDS})\b")),
    ("domain_user", re.compile(r"(?<![\\\w:])[A-Z][A-Z0-9-]{1,15}\\[a-z][\w.-]{1,30}\b")),
]
_IPV6 = re.compile(r"(?<![\w:])[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?![\w:])")


@dataclass(frozen=True)
class LeakHit:
    detector: str
    location: str        # e.g. "E3.body" - never the value


def _mask_tokens(text: str) -> str:
    return _TOKEN.sub("[T]", text)


def scan_text(text: str, location: str, sensitive_values: Iterable[str]) -> list[LeakHit]:
    hits: list[LeakHit] = []
    if not text:
        return hits
    masked = _mask_tokens(text)
    lowered = masked.lower()
    for value in sensitive_values:
        v = value.strip().lower()
        if len(v) < 3:
            continue
        pat = r"\s+".join(re.escape(p) for p in v.split())
        if re.search(rf"(?<![a-z0-9]){pat}(?![a-z0-9])", lowered):
            hits.append(LeakHit("deny_list", location))
            break
    for name, pat in DETECTORS:
        if pat.search(masked):
            hits.append(LeakHit(name, location))
    for m in _IPV6.finditer(masked):
        try:
            ipaddress.IPv6Address(m.group(0))
            hits.append(LeakHit("ipv6", location))
            break
        except ValueError:
            continue
    return hits


def scan_fields(fields: dict[str, str], sensitive_values: Iterable[str]) -> list[LeakHit]:
    values = list(sensitive_values)
    hits: list[LeakHit] = []
    for location, text in fields.items():
        hits.extend(scan_text(text, location, values))
    return hits
