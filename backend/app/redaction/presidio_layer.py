"""Presidio NER layer (spaCy model loaded once, fully offline)."""
from __future__ import annotations

import threading
from typing import Any, Optional

from app.redaction.detectors import Span

_ENTITY_MAP = {
    "PERSON": "PERSON",
    "ORGANIZATION": "COMPANY",
    "EMAIL_ADDRESS": "EMAIL",
    "PHONE_NUMBER": "PHONE",
    "IP_ADDRESS": "IP",
    "URL": "URL",
    "CREDIT_CARD": "SECRET",
    "IBAN_CODE": "ACCOUNT_ID",
    "US_SSN": "ID",
    "US_BANK_NUMBER": "ACCOUNT_ID",
}

_lock = threading.Lock()
_engine: Optional[Any] = None


def _get_engine(model: str):
    global _engine
    with _lock:
        if _engine is None:
            from presidio_analyzer import AnalyzerEngine
            from presidio_analyzer.nlp_engine import NlpEngineProvider

            provider = NlpEngineProvider(nlp_configuration={
                "nlp_engine_name": "spacy",
                "models": [{"lang_code": "en", "model_name": model}],
                "ner_model_configuration": {
                    "model_to_presidio_entity_mapping": {
                        "PERSON": "PERSON", "PER": "PERSON", "ORG": "ORGANIZATION",
                        "GPE": "LOCATION", "LOC": "LOCATION", "NORP": "NRP",
                    },
                    "low_confidence_score_multiplier": 1.0,
                    "low_score_entity_names": [],
                    "labels_to_ignore": ["DATE", "TIME", "CARDINAL", "ORDINAL", "QUANTITY",
                                         "MONEY", "PERCENT", "PRODUCT", "EVENT", "WORK_OF_ART",
                                         "LAW", "LANGUAGE", "FAC"],
                },
            })
            _engine = AnalyzerEngine(nlp_engine=provider.create_engine(), supported_languages=["en"])
        return _engine


class PresidioLayer:
    def __init__(self, cfg: dict[str, Any], model: str):
        pcfg = cfg.get("presidio", {})
        self.entities = list(pcfg.get("entities", list(_ENTITY_MAP)))
        self.threshold = float(pcfg.get("score_threshold", 0.55))
        self.allow = [t for t in cfg.get("allow_terms", [])]
        self.allow_lower = {t.lower() for t in self.allow}
        self.file_ext = {e.lower() for e in cfg.get("file_extensions", [])}
        self.model = model

    def warmup(self) -> None:
        _get_engine(self.model)

    def spans(self, text: str) -> list[Span]:
        if not text.strip():
            return []
        engine = _get_engine(self.model)
        results = engine.analyze(text=text, language="en", entities=self.entities,
                                 score_threshold=self.threshold, allow_list=self.allow)
        out: list[Span] = []
        for r in results:
            entity = _ENTITY_MAP.get(r.entity_type)
            if entity is None:
                continue
            value = text[r.start:r.end]
            stripped = value.strip()
            low = stripped.lower()
            if not stripped or low in self.allow_lower or "[" in stripped or "]" in stripped:
                continue
            if entity == "URL" and "://" not in value and low.rsplit(".", 1)[-1] in self.file_ext:
                continue
            if entity in ("PERSON", "COMPANY"):
                # Ignore pure lowercase or single-character noise.
                if stripped.islower() or len(stripped) < 3:
                    continue
                if all(w.lower() in self.allow_lower for w in stripped.split()):
                    continue
            out.append(Span(r.start, r.end, entity, 50, f"{entity}:{low}", "presidio"))
        return out
