"""Audit quality signals (computed, never self-reported by the LLM).

* Data completeness (0-1): is the source data complete enough to score this case?
  Missing key fields and very short cases lower it.
* Run agreement (0-1, only when >1 run): share of runs that give the most common score,
  taken on the least-agreeing LLM dimension. Evaluator disagreement is flagged when, on any
  LLM dimension, the run score range >= threshold OR the modal share < threshold.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Optional

from app.scoring.score import DimAgg


@dataclass
class Quality:
    data_completeness: float
    completeness_reasons: list[dict[str, Any]] = field(default_factory=list)
    run_agreement: Optional[float] = None
    agreement_details: dict[str, dict[str, Any]] = field(default_factory=dict)
    disagreement: bool = False


def compute_quality(llm: dict[str, DimAgg], missing_fields: list[str], communications: int,
                    scoring_cfg: dict[str, Any], review_cfg: dict[str, Any]) -> Quality:
    c = scoring_cfg["quality"]["data_completeness"]
    reasons: list[dict[str, Any]] = []
    for f in missing_fields:
        reasons.append({"code": "MISSING_FIELD", "field": f, "penalty": c["missing_key_field"]})
    if communications < int(c.get("min_communications", 3)):
        reasons.append({"code": "SHORT_CASE", "communications": communications, "penalty": c["short_case"]})
    completeness = max(0.0, round(1.0 - sum(r["penalty"] for r in reasons), 3))

    dis = review_cfg["rules"].get("EVALUATOR_DISAGREEMENT", {})
    max_range = float(dis.get("run_score_range_at_least", 2))
    min_share = float(dis.get("modal_share_below", 0.75))
    details: dict[str, dict[str, Any]] = {}
    shares: list[float] = []
    disagreement = False
    for name, agg in llm.items():
        scores = [s for s in agg.run_scores if s is not None]
        if len(scores) < 2:
            continue
        rng = max(scores) - min(scores)
        share = Counter(scores).most_common(1)[0][1] / len(scores)
        flagged = rng >= max_range or share < min_share
        details[name] = {"scores": scores, "range": rng, "modal_share": round(share, 3), "disagreement": flagged}
        shares.append(share)
        disagreement = disagreement or flagged
    return Quality(
        data_completeness=completeness, completeness_reasons=reasons,
        run_agreement=round(min(shares), 3) if shares else None,
        agreement_details=details, disagreement=disagreement,
    )
