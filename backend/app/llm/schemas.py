"""Strict output schemas for LLM evaluations. Unknown fields are rejected."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

Status = Literal["OK", "INSUFFICIENT_EVIDENCE"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Evidence(_Strict):
    ref_id: str = Field(min_length=1, max_length=16)
    timestamp: Optional[str] = None


class Finding(_Strict):
    text: str = Field(min_length=1, max_length=600)
    evidence: list[Evidence] = Field(default_factory=list)


class _Scored(_Strict):
    status: Status
    score: Optional[int] = Field(default=None, ge=1, le=5)
    summary: str = Field(default="", max_length=1200)
    top_issues: list[Finding] = Field(default_factory=list, max_length=10)
    coaching_action: str = Field(default="", max_length=600)

    @model_validator(mode="after")
    def _score_matches_status(self):
        if self.status == "OK" and self.score is None:
            raise ValueError("score required when status is OK")
        if self.status == "INSUFFICIENT_EVIDENCE" and self.score is not None:
            raise ValueError("score must be null when status is INSUFFICIENT_EVIDENCE")
        return self


class TroubleshootingEval(_Scored):
    missed_steps: list[Finding] = Field(default_factory=list, max_length=10)
    repeated_requests: list[Finding] = Field(default_factory=list, max_length=10)


class Reading(_Strict):
    """Temperature of one customer message (1 calm .. 5 escalation risk)."""
    ref_id: str = Field(min_length=1, max_length=16)
    score: int = Field(ge=1, le=5)


class TemperatureEval(_Scored):
    # Start, end, peak and trajectory are computed from `readings` in code; a model-supplied
    # trajectory is accepted for backwards compatibility but never used.
    readings: list[Reading] = Field(default_factory=list, max_length=60)
    trajectory: Optional[Literal["improving", "stable", "worsening"]] = None
    shift_points: list[Finding] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def _readings_match_status(self):
        if self.status == "OK" and not self.readings:
            raise ValueError("readings required when status is OK")
        return self


class CommunicationEval(_Scored):
    handover_issues: list[Finding] = Field(default_factory=list, max_length=10)


class ClosureEval(_Strict):
    status: Status
    reason: Optional[Literal["CUSTOMER_NON_RESPONSE", "CUSTOMER_CONFIRMED", "OTHER"]] = None
    evidence: list[Evidence] = Field(default_factory=list)
    explanation: str = Field(default="", max_length=600)

    @model_validator(mode="after")
    def _reason_matches_status(self):
        if self.status == "OK" and (self.reason is None or not self.evidence):
            raise ValueError("reason and evidence required when status is OK")
        return self


SCHEMAS = {
    "troubleshooting": TroubleshootingEval,
    "temperature": TemperatureEval,
    "communication": CommunicationEval,
    "closure_reason": ClosureEval,
}

# Lists of findings per dimension that must carry evidence.
FINDING_FIELDS = {
    "troubleshooting": ["top_issues", "missed_steps", "repeated_requests"],
    "temperature": ["top_issues", "shift_points"],
    "communication": ["top_issues", "handover_issues"],
    "closure_reason": [],
}
