"""Elapsed time under a 24x7 or business-hours clock."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def elapsed_minutes(start: datetime, end: datetime, clock: str, bh: dict[str, Any]) -> float:
    if end <= start:
        return 0.0
    if clock != "business_hours":
        return (end - start).total_seconds() / 60.0
    tz = ZoneInfo(bh.get("timezone", "UTC"))
    days = {_DAYS.index(d.lower()[:3]) for d in bh.get("days", _DAYS[:5])}
    open_t = time.fromisoformat(bh.get("start", "09:00"))
    close_t = time.fromisoformat(bh.get("end", "17:00"))
    holidays = {date.fromisoformat(str(h)) for h in bh.get("holidays", [])}
    s, e = start.astimezone(tz), end.astimezone(tz)
    total = 0.0
    day = s.date()
    while day <= e.date():
        if day.weekday() in days and day not in holidays:
            w_start = datetime.combine(day, open_t, tz)
            w_end = datetime.combine(day, close_t, tz)
            lo, hi = max(w_start, s), min(w_end, e)
            if hi > lo:
                total += (hi - lo).total_seconds() / 60.0
        day += timedelta(days=1)
    return total
