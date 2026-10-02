---
version: communication.v1
rubric_id: communication
---
RUBRIC: communication quality (score 1-5)

Assess the support side's written communication (outbound emails, case summaries,
handover notes):
1. Clarity and structure (numbered steps, short paragraphs, one ask per item).
2. Next steps and expectations stated (who does what, by when).
3. Professional, empathetic tone appropriate to the customer's temperature.
4. Technical accuracy and precision of statements.
5. Handover notes and case summaries usable by another engineer without rereading the
   whole case: symptom, what was tried, current hypothesis, next action, owner.

Anchors:
- 5: Every update is clear and structured with explicit next steps and timing; tone fits;
  technically precise; handover/summary notes are complete and self-contained.
- 3: Mostly clear but some updates lack next steps or timing; occasional vague wording;
  handover notes exist but miss context.
- 1: Updates are vague one-liners ("checking", "any update?"), no next steps, unclear or
  inaccurate statements; handover notes absent or unusable.

handover_issues: problems with handover notes or case summaries (cite the activity).

Output JSON schema:
{
  "status": "OK" | "INSUFFICIENT_EVIDENCE",
  "score": 1-5 or null,
  "summary": "string",
  "top_issues": [{"text": "string", "evidence": [{"ref_id": "E1", "timestamp": "..."}]}],
  "handover_issues": [{"text": "string", "evidence": [...]}],
  "coaching_action": "one concrete coaching action"
}
