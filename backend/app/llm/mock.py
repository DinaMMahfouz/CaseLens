"""Deterministic offline mock provider.

It reads the redacted case JSON from the user message and produces rubric-shaped output
from simple text heuristics, always citing real ref_ids. It never follows instructions
found in case content. Used for tests, seeding and offline demos.
"""
from __future__ import annotations

import json
import re
from typing import Any

from app.llm.providers import LLMProvider

HOT = ["unacceptable", "escalat", "urgent", "asap", "frustrat", "disappoint", "still not",
       "still broken", "third time", "manager", "immediately", "!!", "account executive",
       "outage", "cannot work", "hurry", "is anyone looking"]
ASK = re.compile(r"(?i)\b(please (?:send|provide|collect|share|capture|export)|could you (?:send|share))\b([^.\n]{0,60})")
DATA_WORDS = ["log", "trace", "har", "screenshot", "version", "config", "export", "statistics", "output"]
RESOLVED = ["root cause", "workaround", "fix:", "fixed", "resolved", "restart"]


def _case(user: str) -> dict[str, Any]:
    m = re.search(r"<case_data>\n(.*)\n</case_data>", user, re.S)
    return json.loads(m.group(1)) if m else {"case": {}, "timeline": []}


def _n(count: int, word: str, plural: str | None = None) -> str:
    return f"{count} {word if count == 1 else (plural or word + 's')}"


def _ev(item: dict) -> list[dict]:
    return [{"ref_id": item["ref_id"], "timestamp": item.get("timestamp")}]


class MockProvider(LLMProvider):
    name = "mock"
    model = "mock-heuristic-v1"
    effective_temperature = 0.0

    def complete(self, system: str, user: str) -> str:
        data = _case(user)
        if "TASK: classify why" in system:
            return json.dumps(self._closure(data))
        if "RUBRIC: troubleshooting" in system:
            return json.dumps(self._troubleshooting(data))
        if "RUBRIC: customer temperature" in system:
            return json.dumps(self._temperature(data))
        if "RUBRIC: communication" in system:
            return json.dumps(self._communication(data))
        return "{}"

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _split(data):
        tl = data.get("timeline", [])
        out = [i for i in tl if i["type"] == "email" and i["direction"] == "outbound" and not i["auto_acknowledgement"]]
        calls = [i for i in tl if i["type"] == "call"]
        inbound = [i for i in tl if i["type"] == "email" and i["direction"] == "inbound"]
        notes = [i for i in tl if i["type"] in ("summary", "handover", "note")]
        return out, calls, inbound, notes

    def _closure(self, data):
        res = (data.get("case") or {}).get("resolution")
        if not res or not res.get("text"):
            return {"status": "INSUFFICIENT_EVIDENCE", "reason": None, "evidence": [], "explanation": "No resolution text."}
        t = res["text"].lower()
        if any(k in t for k in ["no response", "unresponsive", "not heard", "no reply", "did not respond"]):
            reason = "CUSTOMER_NON_RESPONSE"
        elif any(k in t for k in ["confirmed", "agreed to close"]):
            reason = "CUSTOMER_CONFIRMED"
        else:
            reason = "OTHER"
        return {"status": "OK", "reason": reason, "evidence": [{"ref_id": "RES", "timestamp": res.get("timestamp")}],
                "explanation": f"Resolution text indicates {reason.lower().replace('_', ' ')}."}

    def _troubleshooting(self, data):
        out, calls, inbound, notes = self._split(data)
        if len(out) + len(calls) < 1:
            return {"status": "INSUFFICIENT_EVIDENCE", "score": None, "summary": "No support troubleshooting activity in the case.",
                    "top_issues": [], "missed_steps": [], "repeated_requests": [], "coaching_action": ""}
        score, issues, missed, repeated = 3.0, [], [], []
        first = out[0] if out else calls[0]
        first_text = (first.get("body") or "").lower()
        if any(w in first_text for w in DATA_WORDS):
            score += 1
        else:
            issues.append({"text": "Relevant logs or data were not requested in the first response.", "evidence": _ev(first)})
            score -= 0.5
        asks: dict[str, list[dict]] = {}
        for o in out:
            for m in ASK.finditer(o.get("body") or ""):
                key = next((w for w in DATA_WORDS if w in m.group(2).lower()), None)
                if key:
                    asks.setdefault(key, []).append(o)
        for key, items in asks.items():
            uniq = {i["ref_id"]: i for i in items}
            if len(uniq) >= 2:
                repeated.append({"text": f"Requested the same {key} data {_n(len(uniq), 'time')}.",
                                 "evidence": [e for i in uniq.values() for e in _ev(i)]})
                score -= 1.5
        everything = " ".join((i.get("body") or "").lower() for i in out + notes) + " " + \
            (((data.get("case") or {}).get("resolution") or {}).get("text") or "").lower()
        if any(k in everything for k in RESOLVED):
            score += 1
        else:
            missed.append({"text": "No root cause or workaround documented yet.", "evidence": _ev(out[-1] if out else first)})
            score -= 0.5
        if not any("reproduc" in (o.get("body") or "").lower() for o in out) and len(out) >= 3:
            missed.append({"text": "No attempt to reproduce the issue in a lab is documented.", "evidence": _ev(out[1])})
        score = int(max(1, min(5, round(score))))
        coaching = ("Request all needed diagnostics once, with a reason, and track what was already received."
                    if repeated else "Restate the problem and state the working hypothesis in each update.")
        return {"status": "OK", "score": score,
                "summary": f"{_n(len(out), 'support email')} and {_n(len(calls), 'call')} reviewed; "
                           f"{_n(len(repeated), 'repeated request type')}.",
                "top_issues": issues, "missed_steps": missed, "repeated_requests": repeated, "coaching_action": coaching}

    def _temperature(self, data):
        _, calls, inbound, _ = self._split(data)
        desc = (data.get("case") or {}).get("description")
        msgs = ([{"ref_id": "DESC", "timestamp": desc.get("timestamp"), "body": desc.get("text")}] if desc and desc.get("text") else []) + inbound
        if not msgs:
            return {"status": "INSUFFICIENT_EVIDENCE", "score": None, "readings": [], "summary": "No customer messages.",
                    "top_issues": [], "shift_points": [], "coaching_action": ""}
        heat = [min(5, 1 + sum(h in (m.get("body") or "").lower() for h in HOT)) for m in msgs]
        score = heat[-1]
        readings = [{"ref_id": m["ref_id"], "score": h} for m, h in zip(msgs, heat)]
        trajectory = "worsening" if heat[-1] > heat[0] else "improving" if heat[-1] < heat[0] else "stable"
        shifts = [{"text": f"Customer temperature {'rose' if heat[i] > heat[i-1] else 'eased'} here.", "evidence": _ev(msgs[i])}
                  for i in range(1, len(heat)) if abs(heat[i] - heat[i - 1]) >= 1]
        issues = [{"text": "Customer signals escalation risk.", "evidence": _ev(msgs[i])}
                  for i in range(len(heat)) if heat[i] >= 4][:3]
        return {"status": "OK", "score": score, "readings": readings,
                "summary": f"Customer was {trajectory} across {_n(len(msgs), 'customer message')}.",
                "top_issues": issues, "shift_points": shifts,
                "coaching_action": "Acknowledge the impact explicitly and give a dated action plan." if score >= 4
                else "Keep proactive, dated updates to maintain customer confidence."}

    def _communication(self, data):
        out, calls, inbound, notes = self._split(data)
        if not out:
            return {"status": "INSUFFICIENT_EVIDENCE", "score": None, "summary": "No outbound support communication to assess.",
                    "top_issues": [], "handover_issues": [], "coaching_action": ""}
        score, issues, handover = 3.0, [], []
        with_next = [o for o in out if re.search(r"(?i)next step|i will|update you|please confirm|let me know", o.get("body") or "")]
        if len(with_next) >= max(1, len(out) // 2 + 1):
            score += 1
        short = [o for o in out if len(re.sub(r"(?i)^h(i|ello)[^\n]*\n*", "", (o.get("body") or "").strip())) < 40]
        for o in short[:3]:
            issues.append({"text": "Update is a vague one-liner without next steps.", "evidence": _ev(o)})
        if short:
            score -= 1 if len(short) == 1 else 2
        for n in notes:
            if n["type"] == "handover" and len(n.get("body") or "") < 120:
                handover.append({"text": "Handover note lacks symptom, actions tried and next step.", "evidence": _ev(n)})
                score -= 1
        if any(n["type"] in ("summary", "handover") and len(n.get("body") or "") >= 120 for n in notes):
            score += 0.5
        score = int(max(1, min(5, round(score))))
        return {"status": "OK", "score": score,
                "summary": f"{_n(len(out), 'outbound update')}, {len(with_next)} with explicit next steps; "
                           f"{_n(len(handover), 'handover issue')}.",
                "top_issues": issues, "handover_issues": handover,
                "coaching_action": "Write handover notes with symptom, actions tried, hypothesis and next step." if handover
                else "End every update with a dated next step and owner."}
