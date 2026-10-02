"""Timestamp normalization: mixed formats and time zones in, aware UTC out."""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo


def _is_blank(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, float) and math.isnan(value):
        return True
    if isinstance(value, str) and not value.strip():
        return True
    try:
        import pandas as pd
        if value is pd.NaT:
            return True
    except Exception:  # pragma: no cover
        pass
    return False


def to_utc(value: Any, formats: list[str], default_tz: str = "UTC") -> tuple[Optional[datetime], bool]:
    """Parse a timestamp. Returns (utc_datetime | None, parse_failed)."""
    if _is_blank(value):
        return None, False
    tz = ZoneInfo(default_tz)
    dt: Optional[datetime] = None
    if hasattr(value, "to_pydatetime"):
        dt = value.to_pydatetime()
    elif isinstance(value, datetime):
        dt = value
    elif isinstance(value, (int, float)):
        # Excel serial date
        try:
            from openpyxl.utils.datetime import from_excel
            dt = from_excel(value)
        except Exception:
            return None, True
    else:
        text = str(value).strip()
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            for fmt in formats:
                try:
                    dt = datetime.strptime(text, fmt)
                    break
                except ValueError:
                    continue
        if dt is None:
            return None, True
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz)
    return dt.astimezone(timezone.utc), False
