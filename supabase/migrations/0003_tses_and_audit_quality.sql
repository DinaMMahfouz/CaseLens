-- Phase 1: TSE identity by id, audit quality fields, audit timestamps.
--
-- * public.tses holds support engineers. Cases reference tse_id; access rules use ids only.
-- * Backfill from the existing owner names (one-time), then drop the name column.
-- * A TSE login is linked through tses.auth_user_id (the demo login -> Marta Lindqvist).

-- ------------------------------------------------------------------ tses
create table public.tses (
  id uuid primary key default gen_random_uuid(),
  display_name text not null unique,
  email text,
  auth_user_id uuid unique references auth.users (id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.tses (display_name)
select distinct owner_name from public.cases where owner_name <> ''
union
select distinct tse_name from private.pending_profiles where tse_name is not null
union
select distinct tse_name from public.profiles where tse_name is not null
on conflict (display_name) do nothing;

alter table public.cases add column tse_id uuid references public.tses (id);
update public.cases c set tse_id = t.id from public.tses t where t.display_name = c.owner_name;
create index cases_tse_id_idx on public.cases (tse_id);
create index cases_case_number_idx on public.cases (case_number);
create index cases_closed_at_idx on public.cases (closed_at);

-- Link existing TSE logins to their tses row; their display name becomes the TSE's name.
update public.tses t set auth_user_id = p.id, email = p.email
from public.profiles p where p.role = 'tse' and p.tse_name = t.display_name;
update public.profiles p set display_name = t.display_name
from public.tses t where t.auth_user_id = p.id;

-- Pending role assignments reference a tses row instead of a name.
alter table private.pending_profiles add column tse_id uuid references public.tses (id);
update private.pending_profiles pp set tse_id = t.id from public.tses t where t.display_name = pp.tse_name;
update private.pending_profiles pp set display_name = t.display_name
from public.tses t where t.id = pp.tse_id;
alter table private.pending_profiles drop constraint pending_tse_needs_name;
alter table private.pending_profiles drop column tse_name;
alter table private.pending_profiles add constraint pending_tse_needs_id check (role <> 'tse' or tse_id is not null);

create or replace function private.apply_pending_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p private.pending_profiles;
begin
  select * into p from private.pending_profiles where lower(email) = lower(new.email);
  if found then
    insert into public.profiles (id, email, display_name, role)
    values (new.id, new.email, p.display_name, p.role)
    on conflict (id) do update set role = excluded.role, display_name = excluded.display_name;
    if p.tse_id is not null then
      update public.tses set auth_user_id = new.id, email = new.email where id = p.tse_id;
    end if;
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------------ access rules by id
create or replace function private.my_tse_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select t.id from public.tses t
  join public.profiles p on p.id = t.auth_user_id and p.role = 'tse'
  where t.auth_user_id = (select auth.uid());
$$;

create or replace function private.can_see_case(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_manager()
      or exists (select 1 from public.cases c where c.id = target and c.tse_id = private.my_tse_id());
$$;

drop policy "manager or owning TSE" on public.cases;
create policy "manager or owning TSE" on public.cases for select to authenticated
  using ((select private.is_manager()) or tse_id = (select private.my_tse_id()));

alter table public.tses enable row level security;
create policy "manager sees all TSEs, TSE sees self" on public.tses for select to authenticated
  using ((select private.is_manager()) or id = (select private.my_tse_id()));
revoke all on public.tses from anon;
revoke insert, update, delete, truncate on public.tses from authenticated;
grant select on public.tses to authenticated;

drop function private.my_tse_name();
alter table public.profiles drop constraint tse_needs_name;
alter table public.profiles drop column tse_name;
alter table public.cases drop column owner_name;

grant execute on all functions in schema private to authenticated;
revoke execute on all functions in schema private from anon, public;
revoke execute on function private.apply_pending_profile() from authenticated;

-- ------------------------------------------------------------------ audit quality + timestamps
alter table public.audits
  add column audited_at timestamptz,
  add column config_hash text not null default '',
  add column temp_start double precision,
  add column temp_end double precision,
  add column temp_peak double precision,
  add column scored_dimensions integer not null default 0,
  add column applicable_dimensions integer not null default 0,
  add column data_completeness double precision,
  add column completeness_reasons jsonb not null default '[]'::jsonb,
  add column run_agreement double precision,
  add column agreement_details jsonb not null default '{}'::jsonb,
  add column is_heuristic boolean not null default false;
update public.audits a set audited_at = coalesce(a.audited_at, a.created_at),
                          config_hash = r.config_hash, is_heuristic = (a.provider = 'mock')
from public.runs r where r.id = a.run_id;
alter table public.audits drop column confidence_score, drop column confidence_level,
                          drop column confidence_reasons;
