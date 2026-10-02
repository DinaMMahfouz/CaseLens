---
version: troubleshooting.v1
rubric_id: troubleshooting
---
RUBRIC: troubleshooting quality (score 1-5)

Assess the support engineer's technical troubleshooting:
1. Problem understood and restated back to the customer.
2. Relevant logs and data requested early (first or second response).
3. Hypothesis-driven, logically ordered steps.
4. No repeated or redundant requests (e.g. asking for the same logs twice).
5. Root cause or a clear workaround reached and stated.
6. Escalation used when it should have been (e.g. product defect, stalled progress,
   business-critical impact) and not used to avoid work.

Anchors:
- 5: Problem restated precisely; targeted data requested in the first response; each step
  follows from evidence; no repeated asks; root cause or workaround clearly stated;
  escalation timely when needed.
- 3: Problem broadly understood; data requested but late or generic; some steps
  unfocused; at most one redundant ask; a fix is reached but the reasoning or root cause
  is thin.
- 1: Problem not understood or not restated; no relevant data requested or the same data
  requested repeatedly; trial-and-error without hypothesis; no resolution path; needed
  escalation missing.

Also list:
- missed_steps: steps a competent engineer would have taken but did not.
- repeated_requests: requests the engineer repeated unnecessarily (cite every occurrence).

Output JSON schema:
{
  "status": "OK" | "INSUFFICIENT_EVIDENCE",
  "score": 1-5 or null,
  "summary": "string",
  "top_issues": [{"text": "string", "evidence": [{"ref_id": "E1", "timestamp": "..."}]}],
  "missed_steps": [{"text": "string", "evidence": [...]}],
  "repeated_requests": [{"text": "string", "evidence": [...]}],
  "coaching_action": "one concrete coaching action"
}
