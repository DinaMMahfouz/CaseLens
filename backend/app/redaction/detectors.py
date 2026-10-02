"""Span detectors for the deny-list and technical-identifier regex layers."""
from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from typing import Any, Iterable, Optional


@dataclass(frozen=True)
class Span:
    start: int
    end: int
    entity: str          # pseudonym token prefix, e.g. EMAIL, PERSON, HOST
    priority: int
    key: str             # normalization key used for consistent pseudonyms
    layer: str           # denylist | regex | presidio | heuristic

    @property
    def length(self) -> int:
        return self.end - self.start


# --------------------------------------------------------------------------- deny-list
@dataclass(frozen=True)
class DenyEntry:
    value: str
    entity: str
    group: str           # entries sharing a group share one pseudonym


def deny_spans(text: str, entries: Iterable[DenyEntry]) -> list[Span]:
    spans: list[Span] = []
    for e in entries:
        if len(e.value) < 3:
            continue
        pattern = r"\s+".join(re.escape(part) for part in e.value.split())
        for m in re.finditer(rf"(?<![A-Za-z0-9]){pattern}(?![A-Za-z0-9])", text, re.IGNORECASE):
            spans.append(Span(m.start(), m.end(), e.entity, 100, f"deny:{e.group}", "denylist"))
    return spans


# --------------------------------------------------------------------------- regex
_IPV6_CAND = re.compile(
    r"(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){2,7}:?(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})?(?:%\w+)?(?![\w:])"
)
_IPV4 = re.compile(r"(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:/\d{1,2})?(?![\d.])")


def _pattern_table(cfg: dict[str, Any]) -> list[tuple[str, re.Pattern, int, int]]:
    """(entity, regex, group, priority)."""
    acct = "|".join(re.escape(p) for p in cfg.get("reference_id_prefixes", []))
    emp = "|".join(re.escape(p) for p in cfg.get("employee_id_prefixes", []))
    I = re.IGNORECASE
    table: list[tuple[str, re.Pattern, int, int]] = [
        ("CERT", re.compile(r"-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----"), 0, 95),
        ("SECRET", re.compile(r"(?i)\b(?:password|passwd|passcode|pwd|pass|secret|client[_ -]?secret|shared[_ -]?secret|api[_ -]?key|apikey|access[_ -]?key|auth[_ -]?token|access[_ -]?token|refresh[_ -]?token|private[_ -]?key|seed|otp[_ -]?seed|token[_ -]?seed)\s*[:=]\s*(\"[^\"]+\"|'[^']+'|\S+)"), 1, 90),
        ("SECRET", re.compile(r"(?i)\b(?:password|passcode|pwd)\s+(?:is|was|set to|reset to)\s+(\S+)"), 1, 90),
        ("SECRET", re.compile(r"(?i)\bbearer\s+([A-Za-z0-9._~+/-]{8,}=*)"), 1, 90),
        ("SESSION_ID", re.compile(r"(?i)\b(?:session[_ -]?id|jsessionid|sessionid|sid|sess|session|cookie|session[_ -]?cookie)\s*[:=]\s*(\S+)"), 1, 88),
        ("EMAIL", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), 0, 85),
        ("URL", re.compile(r"(?i)\b(?:https?|ftps?|ldaps?|sftp)://[^\s<>\"')\]]+"), 0, 80),
        ("PATH", re.compile(r"\\\\[A-Za-z0-9._$-]+(?:\\[^\s\\/:*?\"<>|]+)+\\?"), 0, 78),
        ("PATH", re.compile(r"(?i)\b[A-Z]:\\(?:Users|Documents and Settings)\\[^\s\"'<>|]+"), 0, 78),
        ("PATH", re.compile(r"(?<![\w/])/(?:home|Users)/[^\s\"'<>|]+"), 0, 78),
        ("DN", re.compile(r"(?i)\b(?:CN|OU|DC|O|L|ST|C|UID)=[^,\n;=]+(?:\s*,\s*(?:CN|OU|DC|O|L|ST|C|UID)=[^,\n;=]+)+"), 0, 76),
        ("USERNAME", re.compile(r"(?<![\\\w:])[A-Z][A-Z0-9-]{1,15}\\[A-Za-z][A-Za-z0-9._-]{1,30}\b"), 0, 74),
        ("USERNAME", re.compile(r"(?i)\b(?:user(?:name)?|user[_ -]?id|userid|login|logon(?:\s+name)?|uid|samaccountname|upn)\s*[:=]\s*(\"[^\"]+\"|\S+)"), 1, 74),
        ("EMPLOYEE_ID", re.compile(rf"(?i)\b(?:{emp})[-_ #]?\d{{3,}}\b"), 0, 72),
        ("EMPLOYEE_ID", re.compile(r"(?i)\bemployee\s*(?:id|number|no\.?|#)\s*[:#=]?\s*([A-Z0-9-]{3,})"), 1, 72),
        ("ACCOUNT_ID", re.compile(rf"(?i)\b(?:{acct})[-_ #]?\d{{3,}}[A-Z0-9-]*\b"), 0, 72),
        ("ACCOUNT_ID", re.compile(r"(?i)\b(?:account|contract|customer|agreement|subscription)\s*(?:id|number|no\.?|#|ref(?:erence)?)\s*[:#=]?\s*([A-Z0-9-]{4,})"), 1, 72),
        ("ACCOUNT_ID", re.compile(r"\b(?:001|003|500|006|800)(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b"), 0, 71),
        ("ID", re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"), 0, 70),
        ("LICENSE_KEY", re.compile(r"\b[A-Z0-9]{4,6}(?:-[A-Z0-9]{4,6}){3,}\b"), 0, 70),
        ("SERIAL", re.compile(r"(?i)\b(?:token\s+serial|serial(?:\s*(?:number|no\.?|#))?|s/n|sn)\s*[:#=]?\s*([A-Z0-9][A-Z0-9-]{5,})"), 1, 70),
        ("MAC", re.compile(r"\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b"), 0, 69),
        ("PHONE", re.compile(r"(?<![\w+])\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d{1,4}(?:[\s.-]?\d{2,4}){2,4}(?!\w)"), 0, 68),
        ("PHONE", re.compile(r"(?<!\w)\(\d{3}\)\s?\d{3}[\s.-]\d{4}(?!\w)"), 0, 68),
        ("PHONE", re.compile(r"(?<![\w.-])\d{3}[.-]\d{3}[.-]\d{4}(?![\w-])(?!\.\d)"), 0, 68),
        ("PHONE", re.compile(r"(?<![\w+.-])0\d{2,4}[\s-]\d{3,4}[\s-]\d{3,4}(?![\w-])(?!\.\d)"), 0, 68),
        ("PHONE", re.compile(r"(?i)\b(?:phone|tel|telephone|mobile|cell|direct|fax)\s*[:.]?\s*([+\d(][\d\s().-]{6,}\d)"), 1, 68),
        ("SERIAL", re.compile(r"(?<![\w.-])\d{9,}(?![\w-])(?!\.\d)"), 0, 66),
        ("SECRET", re.compile(r"\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{28,}={0,2}"), 0, 64),
        ("HOST", re.compile(r"(?i)\b(?:host(?:name)?|server|node|machine|computer|appliance|domain controller|dc|replica|primary)\s*(?:name)?\s*[:=]?\s*([A-Za-z][A-Za-z0-9-]*\d[A-Za-z0-9-]*)\b"), 1, 62),
        ("HOST", re.compile(r"\b[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+-[A-Za-z0-9-]*\d\b"), 0, 60),
    ]
    return table


_FQDN = re.compile(r"\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}\b")


class RegexLayer:
    def __init__(self, cfg: dict[str, Any]):
        self.table = _pattern_table(cfg)
        self.file_ext = {e.lower() for e in cfg.get("file_extensions", [])}
        self.allow = {t.lower() for t in cfg.get("allow_terms", [])}

    def spans(self, text: str) -> list[Span]:
        out: list[Span] = []
        for entity, pat, group, prio in self.table:
            for m in pat.finditer(text):
                start, end = m.span(group)
                if start < 0 or end <= start:
                    continue
                value = text[start:end].strip("\"'.,;")
                if value.lower() in self.allow or value.startswith("["):
                    continue
                out.append(Span(start, start + len(text[start:end].rstrip(".,;")), entity, prio,
                                f"{entity}:{value.lower()}", "regex"))
        for m in _IPV4.finditer(text):
            out.append(Span(m.start(), m.end(), "IP", 84, f"IP:{m.group(0)}", "regex"))
        for m in _IPV6_CAND.finditer(text):
            cand = m.group(0).split("%")[0]
            try:
                ipaddress.IPv6Address(cand)
            except ValueError:
                continue
            out.append(Span(m.start(), m.end(), "IP", 84, f"IP:{cand.lower()}", "regex"))
        for m in _FQDN.finditer(text):
            value = m.group(0)
            last = value.rsplit(".", 1)[-1].lower()
            if last in self.file_ext or value.lower() in self.allow:
                continue
            # Skip version-like / abbreviation tokens such as "e.g" handled by TLD length >= 2.
            out.append(Span(m.start(), m.end(), "HOST", 61, f"HOST:{value.lower()}", "regex"))
        return out


# --------------------------------------------------------------------------- heuristics
_GREETING = re.compile(
    r"(?im)^\s*(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening))\s+"
    r"((?:(?:mr|mrs|ms|miss|dr)\.?\s+)?[A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+)?)\s*[,!:]"
)
_GREETING_SKIP = {"team", "all", "there", "support", "everyone", "folks", "sir", "madam", "both"}


def greeting_spans(text: str) -> list[Span]:
    out = []
    for m in _GREETING.finditer(text):
        name = m.group(1)
        if name.lower() in _GREETING_SKIP:
            continue
        out.append(Span(m.start(1), m.end(1), "PERSON", 55, f"PERSON:{name.lower()}", "heuristic"))
    return out


def select_spans(spans: list[Span]) -> list[Span]:
    """Longest span wins; ties broken by priority. Accepted spans never overlap."""
    accepted: list[Span] = []
    for s in sorted(spans, key=lambda s: (-s.length, -s.priority, s.start)):
        if all(s.end <= a.start or s.start >= a.end for a in accepted):
            accepted.append(s)
    return sorted(accepted, key=lambda s: s.start)


def company_variants(name: str, cfg: dict[str, Any]) -> list[str]:
    name = name.strip()
    if not name:
        return []
    suffixes = {s.lower() for s in cfg.get("company_legal_suffixes", [])}
    generic = {s.lower() for s in cfg.get("company_generic_words", [])}
    words = re.sub(r"[.,]", " ", name).split()
    core = [w for w in words if w.lower() not in suffixes]
    variants = {name}
    if core:
        variants.add(" ".join(core))
        first = core[0]
        if len(first) >= 5 and first.lower() not in generic:
            variants.add(first)
    return [v for v in variants if len(v) >= 3]


def person_variants(name: str) -> list[str]:
    name = re.sub(r"\s+", " ", name.strip())
    if not name:
        return []
    parts = [p for p in re.split(r"[\s,]+", name) if len(p) >= 3]
    return list({name, *parts})


def email_parts(address: str) -> tuple[Optional[str], Optional[str]]:
    m = re.search(r"([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})", address or "")
    if not m:
        return None, None
    return m.group(0), m.group(2)
