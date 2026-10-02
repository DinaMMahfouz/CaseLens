---
version: temperature.v1
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

trajectory: compare the early customer messages with the latest ones:
- "improving": the customer became calmer.
- "stable": no meaningful change.
- "worsening": the customer became more heated.

shift_points: each message where the temperature clearly changed, with evidence.

Output JSON schema:
{
  "status": "OK" | "INSUFFICIENT_EVIDENCE",
  "score": 1-5 or null,
  "trajectory": "improving" | "stable" | "worsening" | null,
  "summary": "string",
  "top_issues": [{"text": "string", "evidence": [{"ref_id": "E1", "timestamp": "..."}]}],
  "shift_points": [{"text": "string", "evidence": [...]}],
  "coaching_action": "one concrete coaching action for handling this customer"
}
