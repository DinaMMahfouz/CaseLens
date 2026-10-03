-- Pre-assign a CaseLens role by email: when a user with a listed email is created
-- (dashboard "Add user" or an invite), their profile is created automatically.
create table private.pending_profiles (
  email text primary key,
  display_name text not null,
  role text not null check (role in ('manager', 'tse')),
  tse_name text,
  constraint pending_tse_needs_name check (role <> 'tse' or tse_name is not null)
);
revoke all on private.pending_profiles from anon, authenticated, public;

create or replace function private.apply_pending_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p private.pending_profiles;
begin
  select * into p from private.pending_profiles where lower(email) = lower(new.email);
  if found then
    insert into public.profiles (id, email, display_name, role, tse_name)
    values (new.id, new.email, p.display_name, p.role, p.tse_name)
    on conflict (id) do update set role = excluded.role, tse_name = excluded.tse_name,
                                   display_name = excluded.display_name;
  end if;
  return new;
end;
$$;
revoke execute on function private.apply_pending_profile() from anon, authenticated, public;

create trigger on_auth_user_created_apply_role
after insert on auth.users
for each row execute function private.apply_pending_profile();

-- Demo accounts (create them in the dashboard; roles are applied automatically):
insert into private.pending_profiles (email, display_name, role, tse_name) values
  ('manager@caselens.test', 'Demo Manager', 'manager', null),
  ('dina@caselens.test', 'Dina (TSE demo)', 'tse', 'Marta Lindqvist');
