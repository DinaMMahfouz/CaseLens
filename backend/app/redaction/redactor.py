"""Layered, per-case consistent redaction and pseudonymization.

Pipeline per text: strip (signatures / disclaimers / quoted chains) -> deny-list ->
technical regex -> Presidio NER -> greeting heuristic -> merge spans -> pseudonymize.

The pseudonym map lives only inside a CaseRedactionContext, which is created per case,
kept in memory, and discarded after the case is processed. It is never persisted,
logged, returned by the API or sent to an LLM.
"""
from __future__ import annotations

import hashlib
import hmac
import re
from typing import Any

from app.domain.models import (
    Direction, RawCase, RedactedCase, TimelineItem,
)
from app.redaction.detectors import (
    DenyEntry, RegexLayer, Span, company_variants, deny_spans, email_parts,
    greeting_spans, person_variants, select_spans,
)
from app.redaction.presidio_layer import PresidioLayer
from app.redaction.strip import strip_text


def keyed_label(prefix: str, value: str, key: bytes) -> str:
    if not value:
        return ""
    digest = hmac.new(key, value.strip().lower().encode(), hashlib.sha256).hexdigest()[:6]
    return f"{prefix}-{digest}"


class CaseRedactionContext:
    """Per-case pseudonym state. In memory only; never serialize."""

    __slots__ = ("_tokens", "_counters", "_deny", "_sensitive")

    def __init__(self, deny: list[DenyEntry]):
        self._tokens: dict[str, str] = {}
        self._counters: dict[str, int] = {}
        self._deny = deny
        self._sensitive: set[str] = {d.value for d in deny}

    def __repr__(self) -> str:  # never reveal contents
        return f"<CaseRedactionContext entries={len(self._tokens)}>"

    def __getstate__(self):  # refuse pickling
        raise TypeError("CaseRedactionContext must not be serialized")

    @property
    def deny(self) -> list[DenyEntry]:
        return self._deny

    def add_deny(self, entries: list[DenyEntry]) -> None:
        known = {(d.value.lower(), d.entity) for d in self._deny}
        for e in entries:
            if (e.value.lower(), e.entity) not in known:
                self._deny.append(e)
                self._sensitive.add(e.value)
                known.add((e.value.lower(), e.entity))

    def sensitive_values(self) -> list[str]:
        """Raw values the leak scanner must never see in output. Memory only."""
        return [v for v in self._sensitive if len(v) >= 3]

    def token(self, span: Span, value: str) -> str:
        if span.layer != "denylist":
            self._sensitive.add(value.strip())
        if span.key not in self._tokens:
            n = self._counters.get(span.entity, 0) + 1
            self._counters[span.entity] = n
            self._tokens[span.key] = f"[{span.entity}_{n}]"
        return self._tokens[span.key]


class Redactor:
    def __init__(self, redaction_cfg: dict[str, Any], app_cfg: dict[str, Any], key: bytes):
        self.cfg = redaction_cfg
        self.strip_cfg = redaction_cfg.get("strip", {})
        self.enabled = bool(app_cfg.get("redaction", {}).get("enabled", True))
        self.display = app_cfg.get("display", {})
        self.key = key
        self.regex = RegexLayer(redaction_cfg)
        self.presidio = PresidioLayer(redaction_cfg, app_cfg.get("redaction", {}).get("spacy_model", "en_core_web_lg"))

    # ---------------------------------------------------------------- deny-list
    def build_deny(self, raw: RawCase, roster: list[str]) -> list[DenyEntry]:
        entries: list[DenyEntry] = []
        if raw.account_name:
            for v in company_variants(raw.account_name, self.cfg):
                entries.append(DenyEntry(v, "COMPANY", "company"))
        if raw.account_number:
            entries.append(DenyEntry(raw.account_number, "ACCOUNT_ID", "account_number"))
        if raw.contact_name:
            for v in person_variants(raw.contact_name):
                entries.append(DenyEntry(v, "PERSON", f"p:{raw.contact_name.lower()}"))
        if raw.contact_phone:
            entries.append(DenyEntry(raw.contact_phone, "PHONE", "contact_phone"))
        address_blob = [raw.contact_email]
        for c in raw.communications:
            address_blob += [c.from_address, c.to_address, c.cc_address]
            for disp in re.findall(r'"?([^"<>;,]+?)"?\s*<[^>]+>', f"{c.to_address};{c.cc_address}"):
                for v in person_variants(disp):
                    entries.append(DenyEntry(v, "PERSON", f"p:{disp.strip().lower()}"))
            if c.author_name:
                for v in person_variants(c.author_name):
                    entries.append(DenyEntry(v, "PERSON", f"p:{c.author_name.lower()}"))
        for blob in address_blob:
            for part in re.split(r"[;,]", blob or ""):
                email, domain = email_parts(part)
                if not email:
                    continue
                entries.append(DenyEntry(email, "EMAIL", f"e:{email.lower()}"))
                if domain:
                    entries.append(DenyEntry(domain, "DOMAIN", f"d:{domain.lower()}"))
                    stem = domain.split(".")[0]
                    if len(stem) >= 6:
                        entries.append(DenyEntry(stem, "DOMAIN", f"d:{domain.lower()}"))
        for name in [raw.owner, *roster, *(a.author_name for a in raw.activities)]:
            for v in person_variants(name or ""):
                entries.append(DenyEntry(v, "PERSON", f"p:{(name or '').lower()}"))
        # Longer values first so a full name matches before its parts.
        uniq: dict[tuple[str, str], DenyEntry] = {}
        for e in sorted(entries, key=lambda e: -len(e.value)):
            uniq.setdefault((e.value.lower(), e.entity), e)
        return list(uniq.values())

    # ---------------------------------------------------------------- spans
    def _discover(self, text: str) -> list[DenyEntry]:
        found: list[DenyEntry] = []
        for s in self.presidio.spans(text) + greeting_spans(text):
            if s.entity == "PERSON":
                name = text[s.start:s.end].strip()
                for v in person_variants(name):
                    found.append(DenyEntry(v, "PERSON", f"p:{name.lower()}"))
            elif s.entity == "COMPANY":
                name = text[s.start:s.end].strip()
                found.append(DenyEntry(name, "COMPANY", f"c:{name.lower()}"))
        # Identifiers found by context (e.g. "user: jdoe", "server AUTHSRV02") are
        # redacted everywhere in the case, including where the context words are absent.
        for s in select_spans(self.regex.spans(text)):
            if s.entity in ("USERNAME", "HOST", "EMPLOYEE_ID", "ACCOUNT_ID", "SERIAL") and s.length >= 4:
                value = text[s.start:s.end].strip()
                found.append(DenyEntry(value, s.entity, s.key))
        return found

    def _redact_text(self, text: str, ctx: CaseRedactionContext) -> str:
        if not text:
            return ""
        spans = (deny_spans(text, ctx.deny) + self.regex.spans(text)
                 + self.presidio.spans(text) + greeting_spans(text))
        out, pos = [], 0
        for s in select_spans(spans):
            out.append(text[pos:s.start])
            out.append(ctx.token(s, text[s.start:s.end]))
            pos = s.end
        out.append(text[pos:])
        return "".join(out)

    # ---------------------------------------------------------------- case
    def new_context(self, raw: RawCase, roster: list[str]) -> CaseRedactionContext:
        return CaseRedactionContext(self.build_deny(raw, roster))

    def redact_case(self, raw: RawCase, roster: list[str]) -> tuple[RedactedCase, CaseRedactionContext]:
        ctx = self.new_context(raw, roster)

        acts = sorted(raw.activities, key=lambda a: (a.occurred_at is None, a.occurred_at.timestamp() if a.occurred_at else 0))
        comms = sorted(raw.communications, key=lambda c: (c.occurred_at is None, c.occurred_at.timestamp() if c.occurred_at else 0))

        # Stage 1: strip, then discover names/orgs across the whole case.
        stripped: dict[str, str] = {
            "subject": strip_text(raw.subject, self.strip_cfg, is_email=False),
            "description": strip_text(raw.description, self.strip_cfg, is_email=True),
            "resolution": strip_text(raw.resolution, self.strip_cfg, is_email=False),
        }
        for i, c in enumerate(comms):
            stripped[f"c{i}s"] = strip_text(c.subject, self.strip_cfg, is_email=False)
            stripped[f"c{i}b"] = strip_text(c.body, self.strip_cfg, is_email=c.kind == "email")
        for i, a in enumerate(acts):
            stripped[f"a{i}s"] = strip_text(a.subject, self.strip_cfg, is_email=False)
            stripped[f"a{i}b"] = strip_text(a.body, self.strip_cfg, is_email=False)

        if self.enabled:
            for text in stripped.values():
                ctx.add_deny(self._discover(text))
            red = {k: self._redact_text(v, ctx) for k, v in stripped.items()}
        else:
            red = dict(stripped)

        items: list[TimelineItem] = []
        counters = {"email": 0, "call": 0, "act": 0}
        missing: list[str] = []
        for i, c in enumerate(comms):
            if c.kind == "email":
                counters["email"] += 1
                ref = f"E{counters['email']}"
                role = "system" if c.is_auto_ack else ("customer" if c.direction == Direction.INBOUND else "support")
            else:
                counters["call"] += 1
                ref = f"C{counters['call']}"
                role = "support"
                if c.direction_inferred and "call_direction" not in missing:
                    missing.append("call_direction")
            items.append(TimelineItem(
                ref_id=ref, item_type=c.kind, direction=c.direction, internal=False,
                author_role=role, occurred_at=c.occurred_at, subject=red[f"c{i}s"],
                body=red[f"c{i}b"], is_auto_ack=c.is_auto_ack,
            ))
        for i, a in enumerate(acts):
            counters["act"] += 1
            items.append(TimelineItem(
                ref_id=f"A{counters['act']}", item_type=a.kind, direction=None,
                internal=a.internal, author_role="support", occurred_at=a.occurred_at,
                subject=red[f"a{i}s"], body=red[f"a{i}b"],
            ))
        items.sort(key=lambda it: (it.occurred_at is None, it.occurred_at.timestamp() if it.occurred_at else 0))

        if raw.severity is None:
            missing.append("severity")
        if raw.opened_at is None:
            missing.append("opened_at")
        if raw.is_closed and raw.closed_at is None:
            missing.append("closed_at")
        if not raw.owner:
            missing.append("owner")
        if any(it.occurred_at is None for it in items):
            missing.append("item_timestamps")

        show_acct = bool(self.display.get("show_account_name", False))
        show_eng = bool(self.display.get("show_engineer_names", False))
        case = RedactedCase(
            case_number=raw.case_number,
            subject=red["subject"],
            description=red["description"],
            severity=raw.severity,
            status=raw.status,
            is_closed=raw.is_closed,
            opened_at=raw.opened_at,
            closed_at=raw.closed_at,
            owner_label=raw.owner if show_eng else keyed_label("TSE", raw.owner, self.key),
            account_label=raw.account_name if show_acct else keyed_label("ACCT", raw.account_name, self.key),
            product=raw.product,
            resolution=red["resolution"],
            items=items,
            status_changes=raw.status_changes,
            missing_fields=missing,
        )
        return case, ctx

    def redact_output(self, text: str, ctx: CaseRedactionContext) -> str:
        """Re-redact LLM output text with the same per-case pseudonym map."""
        if not self.enabled or not text:
            return text
        return self._redact_text(text, ctx)
