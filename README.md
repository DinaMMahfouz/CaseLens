# CaseLens

Quality audits for technical-support cases. CaseLens ingests an export of cases with their
emails and activity logs, **redacts** them, runs deterministic rule checks plus LLM-graded
rubrics, and computes a weighted score. It also computes a confidence level and routes
cases to a human review queue with explicit reasons.

It is decision support. Machine results are never overwritten: reviewer approvals,
overrides and comments go into an append-only trail.

Everything that is a business rule lives in `config/*.yaml`. Rubrics live in versioned
`prompts/*.md` files.

---

## Architecture

```
Worker machine (local)                                Cloud (shared with the team)
───────────────────────────────                       ─────────────────────────────────────────
Excel export (raw, never leaves)                      Supabase: Postgres + Auth + row-level security
  → redact → leak check → LLM → score  ──push──►        stores ONLY redacted audit results
  backend/  (Python, `caselens` CLI)                  Vercel: CaseLens web app (frontend/)
                                                        Manager → all cases, TSE dropdown, review
                                                        TSE     → only their own audited cases
```

- **Raw data stays local.** The audit pipeline (Presidio + spaCy + LLM) runs on the worker
  machine. Only redacted results are pushed to Supabase, using the secret key, which lives
  only in the worker's `.env`.
- **Access is enforced in the database.** Row-level security (`supabase/migrations/`)
  restricts a TSE to rows whose `owner_name` equals their profile's `tse_name`, even when
  they query the API directly. Managers see everything and are the only role that can
  append review actions. The reviewer name is stamped from the session server-side.
  Anonymous users can read nothing.
- **Invite-only accounts.** A signed-in user without a profile sees nothing.

### Roles

| | Manager | TSE |
|---|---|---|
| Sees | All cases, with a **TSE dropdown** to focus on one engineer | Only their own audited cases |
| Screens | Team overview, Cases, Case detail, Review queue, Runs, Export | My overview, My cases, Case detail |
| Can do | Approve / override / comment (append-only) | Read scores, findings, timeline, coaching and the manager's review |

TSE names are shown as real names (agreed). Customer names, accounts and all other
customer PII stay redacted.

---

## Setup

### 1. Supabase (once)

The project `caselens` (ref `ipzlkcejuxilzyphdmgy`) already has the schema from
`supabase/migrations/0001_caselens_schema.sql`. In the Supabase dashboard:

1. **Authentication → Sign In / Providers → Email:** turn **off** "Allow new users to sign up" (invite-only).
2. **Authentication → URL Configuration:** set **Site URL** to the Vercel URL, and add it
   plus `http://localhost:5173` to **Redirect URLs**.
3. **Project Settings → API Keys → Secret keys:** copy a secret key into the root `.env` as
   `SUPABASE_SECRET_KEY` (worker machine only, never on Vercel).

`supabase/tests/rls_check.sql` re-verifies the access rules inside a transaction that rolls back.

### 2. Worker machine: audit and push

Requirements: Python 3.11/3.12 (or Docker, see below).

```bash
cd backend
python -m venv .venv && .venv/Scripts/activate        # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python -m spacy download en_core_web_lg

python -m scripts.caselens audit --fixtures --push                 # synthetic demo data
python -m scripts.caselens audit --file ../data/export.xlsx --push # real export (keep it in data/)
python -m scripts.caselens push --run-id 3 --replace               # re-push a local run
```

### 3. Invite people

```bash
python -m scripts.caselens invite --email manager@company.com --name "Ann Manager" --role manager
python -m scripts.caselens invite --email marta@company.com --name "Marta" --role tse --tse-name "Marta Lindqvist"
```

`--tse-name` must match the **Case Owner** value in the export exactly; that is how a
TSE's account is linked to their cases. Invitees get an email, set a password on first
visit, and land in the view for their role. To change a role, run `invite` again for the
same email.

### 4. Web app on Vercel

Import the GitHub repo in Vercel and leave **Root Directory** at the repo root. The root
`vercel.json` defines a single public service, `frontend` (Vite), that serves every path.
The Python backend is deliberately **not** a Vercel service: it handles raw exports, has no
login of its own, and runs only on the worker machine. Add the environment variables from
`frontend/.env.example` to the Vercel project:

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://ipzlkcejuxilzyphdmgy.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | the publishable key (safe in the browser; RLS protects data) |

The root `vercel.json` also sets SPA routing and security headers. Never add `SUPABASE_SECRET_KEY` to Vercel.

### Local development

```bash
cd frontend && npm install && npm run dev       # http://localhost:5173 against Supabase
```

`docker compose up --build` still runs the local worker API (seeded with synthetic data
and the mock LLM) plus the web app, for offline development.

### Tests

```bash
cd backend
python -m pytest
```

| Suite | Covers |
|---|---|
| `test_redaction.py` | Every entity type; signatures, disclaimers and quoted chains; deny-list and consistent pseudonyms; the leak scanner; zero planted PII after redacting all fixtures; refusal to start with redaction off on non-synthetic data |
| `test_rules.py` | SLO, idle and 3-strike rules, including boundaries (exactly 30 min, exactly 5 days); business-hours clock; spacing and closure-notice options; every fixture's expected outcome |
| `test_llm.py` | Evidence validation (unsupported findings dropped and counted); one retry then `EVAL_FAILED`; `INSUFFICIENT_EVIDENCE`; delimiter and prompt-injection containment; **no fixture PII in any LLM payload**; fail-closed `REDACTION_FAILED` |
| `test_scoring.py` | Normalization; renormalized weights; breach scored as 0; confidence penalties; routing reasons |
| `test_api.py` | Run lifecycle; review routing through the API; filters and sorting; append-only reviewer actions; uploads; **no fixture PII in API responses, DB, logs or export** |
| `test_golden.py` | Agreement metrics |
| `test_sync.py` | Supabase push payload: links, **no customer PII**, engineer names only in the owner field, insert order, duplicate-push protection, SQL rendering, errors that never echo row data |

---

## Pipeline and guardrails

```
source export ─► ExcelAdapter ─► strip ─► deny-list ─► regex ─► Presidio NER ─► pseudonymize
               (raw, memory only)                                                      │
                                         independent leak scanner ◄────────────────────┘
                                              │ any hit → REDACTION_FAILED (fail closed)
                                              ▼
              SLO / idle rules ─► LLM rubrics ×2 ─► 3-strike ─► score ─► confidence ─► routing
                                  (closure reason)    (deterministic count)
```

**Redaction**
- Redaction is on by default. `redaction.enabled: false` is accepted only when
  `data_source.synthetic: true`; otherwise the app refuses to start.
- Uploads are always treated as non-synthetic, so they are refused while redaction is off.
- Pseudonyms are consistent per case: `[EMAIL_1]`, `[IP_1]`, `[HOST_1]`, `[PERSON_1]`,
  `[COMPANY_1]` and so on. A first name and the full name share one token.
- The pseudonym map is created per case in memory and discarded after the case is
  processed. It cannot be pickled and has no table. It never reaches logs, the API or
  the LLM.
- Signatures, legal disclaimers and quoted reply chains are stripped entirely.
- The leak scanner uses its own detectors, separate from the redaction regexes. It checks
  the redacted case, the exact LLM payload text, and the LLM output (which is re-redacted
  with the same map).

**Data handling**
- Only redacted text is stored or displayed.
- Account names appear as keyed pseudonyms (`ACCT-xxxx`). TSE names are shown
  (`display.show_engineer_names: true`); engineer names inside case text stay redacted.
- Logs pass through `logsafe.log_event`, which only accepts whitelisted keys and
  identifier-like values. Query strings are never logged.

**LLM evaluations**
- Case content sits between `<case_data>` delimiters, and the model is told to treat it
  as data.
- Output must be strict JSON validated by Pydantic. Each evaluation gets one retry; if the
  output is still invalid the case is marked `EVAL_FAILED`. There are no silent defaults.
- Every finding needs a valid `ref_id` plus a timestamp. Findings without one are dropped
  and counted.
- Each audit stores the model, the prompt version (front-matter version plus content
  hash) and the effective temperature.

---

## Agreed business rules (defaults)

| Rule | Setting |
|---|---|
| SLO targets | Sev1 30 min, Sev2 3 h, Sev3 4 h, **Sev4 12 h**; 24x7 clock for all severities |
| What counts as a response | Outbound email (not an auto-acknowledgement) or a logged call; internal notes never count |
| Idle threshold | A gap **> 5 calendar days** between customer-facing communications. The case-opened event counts as the first inbound message. Open cases count the gap up to now. |
| Idle side | **CUSTOMER_SIDE only when the customer asked support to wait**, detected from the phrase list in the most recent inbound message. Otherwise the gap is SUPPORT_SIDE: support should have followed up. Only support-side idle is scored. |
| 3-strike | At least 3 outbound attempts (emails or calls) after the customer's last reply, up to closure. **The closure notice counts as an attempt.** Minimum spacing is 0. |
| Closure reason | Classified by the LLM from the **Resolution** field, with evidence. The attempt count stays deterministic. |
| Scoring | Weights 30/20/20/15/10/5. A 1–5 rubric score maps to `(s-1)*2.5` on the /10 scale. Breaches score 0. `NOT_APPLICABLE` and `INSUFFICIENT_DATA` are excluded and the weights renormalized. Idle is binary. |
| Temperature handling | Based on trajectory: improving = 5, stable = 3, worsening = 1. If the two runs disagree, the worse trajectory is used. |
| Confidence | Starts at 1.0. Penalties: −0.20 per dimension where the two runs differ by more than 1; −0.10 per INSUFFICIENT_EVIDENCE; −0.05 per dropped finding; −0.10 per retry; −0.15 per missing key field; −0.15 for fewer than 3 communications. HIGH ≥ 0.80, MEDIUM ≥ 0.50. |
| Review routing | Low score (< 4), low confidence, rule breach, hot customer (temperature ≥ 4 or worsening), eval failed, redaction failed |

---

## Config reference

| File | Contents |
|---|---|
| `config/app.yaml` | Data source (`synthetic`, fixture/upload/output paths), redaction switch and spaCy model, display flags, LLM provider and model settings, job workers |
| `config/mapping.yaml` | Sheet and column names, date formats, default timezone, value aliases (severity, activity types, closed statuses, call direction), support email domains, auto-ack detection |
| `config/rules.yaml` | SLO targets and clocks, business hours and holidays, idle threshold and customer wait phrases, 3-strike attempts, spacing and closure-notice options |
| `config/scoring.yaml` | Weights, normalization, deterministic score maps, trajectory scores, confidence penalties and levels |
| `config/review.yaml` | Routing rules and thresholds; each rule can be switched on or off |
| `config/redaction.yaml` | Presidio entities and threshold, allow-list of technical terms, file extensions, reference/employee ID prefixes, company-name handling, strip patterns |
| `prompts/*.md` | Shared preamble plus one anchored rubric per dimension. Add `x.v2.md` to version a rubric; the highest version is used. |
| `.env` | Secrets only (see `.env.example`) |

### Column mapping (please confirm)

`config/mapping.yaml` was proposed from the synthetic fixture. It assumes a workbook with
four sheets: `Cases`, `Emails`, `Activities` (calls, summaries, handovers, notes) and
`Case History`. **Check it against your real export's headers before uploading real
data.** The Upload & Runs screen shows which mapped columns were found or missing in an
uploaded file.

---

## Switching the LLM provider

Set `llm.provider` in `config/app.yaml` and restart:

| Provider | Setting | Secret / endpoint |
|---|---|---|
| Mock (default; offline, deterministic) | `provider: mock` | none |
| Anthropic API | `provider: anthropic`, `anthropic.model: claude-sonnet-5-5` | `ANTHROPIC_API_KEY` in `.env` |
| OpenAI-compatible | `provider: openai_compatible`, `openai_compatible.model` | `OPENAI_API_KEY`, `OPENAI_BASE_URL` |
| Local Ollama | `provider: ollama`, `ollama.model: llama3.1:8b` | `OLLAMA_BASE_URL` (Docker default: `host.docker.internal:11434`) |

**About temperature 0:** current Claude models reject an explicit non-default
`temperature`, so the Anthropic provider does not send one. Audits record the temperature
as "model default". The provider also enables the server-side refusal fallback. Ollama and
OpenAI-compatible providers run at temperature 0, and Ollama also uses a fixed seed. Every
rubric runs twice regardless of provider, so non-determinism shows up as a confidence
penalty instead of passing silently.

---

## Golden set

Put human-scored cases in `golden/cases/*.json` (format in `golden/README.md`), then:

```bash
cd backend && python -m scripts.golden_agreement          # add --run-id N or --json
```

The report gives exact agreement, within-1 agreement and MAE for each dimension. The two
shipped files are labelled examples, not real judgements.

---

## Project layout

```
config/            business rules, mapping, scoring, routing, redaction (YAML)
prompts/           versioned rubrics with anchors at 1, 3 and 5
backend/app/
  adapters/        SourceAdapter, ExcelAdapter, SalesforceAdapter (stub), date normalization
  redaction/       strip, detectors, Presidio layer, redactor/pseudonymizer, leak scanner
  rules/           SLO, idle, 3-strike, business-hours clock
  llm/             providers (mock, anthropic, openai_compatible, ollama), schemas, evaluator
  scoring/         dimension scores, confidence, review routing
  pipeline.py      per-case audit orchestration
  db/  jobs/  api/  export/
backend/scripts/   gen_fixtures, seed, golden_agreement
backend/tests/     pytest suites
frontend/          React + Vite + TypeScript + Tailwind + Recharts
fixtures/          generated SYNTHETIC data (gitignored outputs)
golden/            human-scored cases
data/ output/      gitignored: real uploads and exports
```

## Known limitations

- Redaction is layered pattern matching plus NER. It is tested against the synthetic
  fixtures, and the leak scanner fails closed, but **validate it on a sample of your real
  data** before relying on it. Add customer-specific patterns in `config/redaction.yaml`.
- The mock provider grades with keyword heuristics. It exists for tests and demos, not
  as a quality judge.
- Background jobs run in-process with state kept in the DB. A run interrupted by a
  restart is marked `failed` and has to be re-run.
- Out of scope for now: Salesforce integration (stub only), SSO (email + password
  invites only), multi-tenancy, write-back, and ranking engineers against each other.
