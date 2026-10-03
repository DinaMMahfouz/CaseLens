---
version: temperature.v2
rubric_id: temperature
---
RUBRIC: customer temperature (score 1-5) and trajectory

Rate how heated the CUSTOMER is at the latest point of the case, based on the customer's
own messages (inbound emails, the case description, and calls they initiated).
1 = calm, 5 = escalation risk.

Anchors:
- 5: Explicit escalation threats (management, account team, legal, churn), anger,
  repeated complaints about the same failure, severe stated business impact.
- 3: Visible frustration or urgency ("still not working", "any update?"), but cooperative.
- 1: Calm, cooperative, neutral or positive tone.

readings: rate EVERY customer message (the case description DESC, inbound emails, and calls
the customer initiated) on the same 1-5 scale, one entry per message, in chronological order.
The start, end, peak and trajectory are computed from these readings by the audit system;
do not output a trajectory.

score: the temperature at the latest customer message (equals the last reading).

shift_points: each message where the temperature clearly changed, with evidence.

Output JSON schema:
{
  "status": "OK" | "INSUFFICIENT_EVIDENCE",
  "score": 1-5 or null,
  "readings": [{"ref_id": "DESC", "score": 1-5}, {"ref_id": "E2", "score": 1-5}],
  "summary": "string",
  "top_issues": [{"text": "string", "evidence": [{"ref_id": "E1", "timestamp": "..."}]}],
  "shift_points": [{"text": "string", "evidence": [...]}],
  "coaching_action": "one concrete coaching action for handling this customer"
}
