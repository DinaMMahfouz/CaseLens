-- Phase 3: run kind and label.
-- kind = 'config_test' marks a run that re-scores cases under changed rules. It is shown only when
-- explicitly selected and is excluded from "previous run" defaults and period (date-range) views.
alter table public.runs
  add column kind text not null default 'normal' check (kind in ('normal', 'config_test')),
  add column label text not null default '';
create index runs_as_of_idx on public.runs (as_of);
