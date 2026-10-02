-- CaseLens schema. Only REDACTED audit results are stored here.
-- Raw case exports never leave the machine that runs the local worker.
--
-- Roles (public.profiles.role):
--   manager : sees every case, filters by TSE, records review actions
--   tse     : sees only cases whose owner_name equals their profile.tse_name (read-only)
-- The local worker writes with the secret (service role) key, which bypasses RLS.

create schema if not exists private;

-- ------------------------------------------------------------------ tables
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text not null,
  role text not null check (role in ('manager', 'tse')),
  tse_name text,                                -- must equal cases.owner_name for TSE users
  created_at timestamptz not null default now(),
  constraint tse_needs_name check (role <> 'tse' or tse_name is not null)
);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  push_key text not null unique,                -- idempotency key from the local worker
  created_at timestamptz not null default now(),
  as_of timestamptz,
  source text not null,
  synthetic boolean not null default false,
  total integer not null default 0,
  failed integer not null default 0,
  provider text not null default '',
  model text not null default '',
  temperature double precision,
  config_hash text not null default '',
  prompt_versions jsonb not null default '{}'::jsonb
);

create table public.cases (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs (id) on delete cascade,
  case_number text not null,
  subject text not null default '',
  description text not null default '',
  severity smallint,
  status text not null default '',
  is_closed boolean not null default false,
  opened_at timestamptz,
  closed_at timestamptz,
  owner_name text not null default '',          -- TSE (support engineer) name
  account_label text not null default '',       -- keyed pseudonym, never the real account
  product text not null default '',
  resolution text not null default '',
  missing_fields jsonb not null default '[]'::jsonb,
  state text not null default 'OK',
  unique (run_id, case_number)
);

create table public.items (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases (id) on delete cascade,
  position integer not null,
  ref_id text not null,
  item_type text not null,
  direction text,
  internal boolean not null default false,
  author_role text not null,
  occurred_at timestamptz,
  subject text not null default '',
  body text not null default '',
  is_auto_ack boolean not null default false
);

create table public.audits (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null unique references public.cases (id) on delete cascade,
  run_id uuid not null references public.runs (id) on delete cascade,
  created_at timestamptz not null default now(),
  state text not null,
  overall double precision,
  dimensions jsonb not null default '[]'::jsonb,
  slo jsonb,
  idle jsonb,
  three_strike jsonb,
  closure jsonb,
  llm jsonb not null default '{}'::jsonb,
  temperature_value double precision,
  trajectory text,
  confidence_score double precision,
  confidence_level text,
  confidence_reasons jsonb not null default '[]'::jsonb,
  review_reasons jsonb not null default '[]'::jsonb,
  needs_review boolean not null default false,
  unsupported_count integer not null default 0,
  retry_count integer not null default 0,
  provider text not null default '',
  model text not null default '',
  temperature double precision,
  prompt_versions jsonb not null default '{}'::jsonb,
  error_kind text not null default ''
);

create table public.findings (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.audits (id) on delete cascade,
  dimension text not null,
  kind text not null,
  text text not null,
  evidence jsonb not null default '[]'::jsonb
);

-- Append-only reviewer trail. Never modifies the machine result in public.audits.
create table public.review_actions (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.audits (id) on delete cascade,
  created_at timestamptz not null default now(),
  action text not null check (action in ('approve', 'override', 'comment')),
  reviewer_id uuid references auth.users (id) on delete set null,
  reviewer_name text not null default '',
  score_override double precision check (score_override between 0 and 10),
  comment text not null default '' check (char_length(comment) <= 4000),
  constraint override_needs_score check ((action = 'override') = (score_override is not null)),
  constraint comment_needs_text check (action <> 'comment' or char_length(btrim(comment)) > 0)
);

create index cases_run_id_idx on public.cases (run_id);
create index cases_owner_name_idx on public.cases (owner_name);
create index items_case_id_idx on public.items (case_id);
create index audits_run_id_idx on public.audits (run_id);
create index findings_audit_id_idx on public.findings (audit_id);
create index review_actions_audit_id_idx on public.review_actions (audit_id);
create index review_actions_reviewer_id_idx on public.review_actions (reviewer_id);

-- ------------------------------------------------------------------ helpers (not exposed via the API)
create or replace function private.is_manager() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'manager');
$$;

create or replace function private.has_role() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()));
$$;

create or replace function private.my_tse_name() returns text
language sql stable security definer set search_path = '' as $$
  select p.tse_name from public.profiles p where p.id = (select auth.uid()) and p.role = 'tse';
$$;

create or replace function private.can_see_case(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_manager()
      or exists (select 1 from public.cases c where c.id = target and c.owner_name = private.my_tse_name());
$$;

create or replace function private.can_see_audit(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.audits a where a.id = target and private.can_see_case(a.case_id));
$$;

grant usage on schema private to authenticated;
grant execute on all functions in schema private to authenticated;
revoke execute on all functions in schema private from anon, public;

-- Reviewer identity comes from the session, never from the client payload.
create or replace function private.stamp_review_action() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.reviewer_id := (select auth.uid());
  new.reviewer_name := coalesce((select p.display_name from public.profiles p where p.id = new.reviewer_id), '');
  new.created_at := now();
  return new;
end;
$$;

create trigger review_actions_stamp before insert on public.review_actions
for each row execute function private.stamp_review_action();

-- ------------------------------------------------------------------ RLS
alter table public.profiles enable row level security;
alter table public.runs enable row level security;
alter table public.cases enable row level security;
alter table public.items enable row level security;
alter table public.audits enable row level security;
alter table public.findings enable row level security;
alter table public.review_actions enable row level security;

create policy "own profile or manager" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select private.is_manager()));

create policy "any CaseLens user can see run metadata" on public.runs for select to authenticated
  using ((select private.has_role()));

create policy "manager or owning TSE" on public.cases for select to authenticated
  using ((select private.is_manager()) or owner_name = (select private.my_tse_name()));

create policy "visible case" on public.items for select to authenticated
  using (private.can_see_case(case_id));

create policy "visible case" on public.audits for select to authenticated
  using (private.can_see_case(case_id));

create policy "visible audit" on public.findings for select to authenticated
  using (private.can_see_audit(audit_id));

create policy "visible audit" on public.review_actions for select to authenticated
  using (private.can_see_audit(audit_id));

create policy "managers append review actions" on public.review_actions for insert to authenticated
  with check ((select private.is_manager()) and private.can_see_audit(audit_id));

-- Defense in depth: clients can only read, except managers appending review actions.
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;
grant insert on public.review_actions to authenticated;
