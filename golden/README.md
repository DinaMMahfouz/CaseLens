# Golden set

Human-scored cases used to measure machine-vs-human agreement per dimension.

```
golden/
  cases/
    <case_number>.json     one file per human-scored case
```

File format:

```json
{
  "case_number": "00100013",
  "reviewer": "initials or role",
  "scored_at": "2026-10-03",
  "scores": {
    "troubleshooting": 2,
    "communication": 2,
    "temperature": 5,
    "slo": "MET",
    "idle": "NO_SUPPORT_IDLE",
    "three_strike": "NOT_APPLICABLE"
  },
  "notes": "free text, redacted"
}
```

Use `null` for a dimension the reviewer did not score. Score the case from the
**redacted** view in the UI; golden files must never contain raw customer data.

Run the report (uses the latest completed run unless `--run-id` is given):

```
cd backend
python -m scripts.golden_agreement
python -m scripts.golden_agreement --run-id 3 --json
```

Metrics: `exact` (share of identical scores/outcomes), `within_1` (1-5 rubrics only),
`MAE` (mean absolute error on the 1-5 scale).

The two files shipped in `cases/` are illustrative examples for the synthetic fixtures,
not real human judgements. Replace them with your reviewers' scores.
