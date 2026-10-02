---
version: closure_reason.v1
rubric_id: closure_reason
---
TASK: classify why this closed case was closed.

Use the resolution field (ref_id "RES") first, then the last communications.
- "CUSTOMER_NON_RESPONSE": closed because the customer stopped responding.
- "CUSTOMER_CONFIRMED": closed after the customer confirmed resolution or agreed to close.
- "OTHER": any other reason (duplicate, out of scope, closed by customer request without
  confirmation of a fix, etc.).
If the data does not say why the case was closed, return "INSUFFICIENT_EVIDENCE".

You only classify the reason. Do not count contact attempts; that is done elsewhere.

Output JSON schema:
{
  "status": "OK" | "INSUFFICIENT_EVIDENCE",
  "reason": "CUSTOMER_NON_RESPONSE" | "CUSTOMER_CONFIRMED" | "OTHER" | null,
  "evidence": [{"ref_id": "RES", "timestamp": "..."}],
  "explanation": "one sentence"
}
