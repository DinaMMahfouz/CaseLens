-- Row-level security check. Runs entirely inside a transaction and ROLLS BACK.
-- Paste into the Supabase SQL editor; the final SELECT shows what each role can see.
begin;
insert into auth.users (id, email, aud, role) values
 ('00000000-0000-0000-0000-0000000000a1','mgr@test.invalid','authenticated','authenticated'),
 ('00000000-0000-0000-0000-0000000000b2','tse@test.invalid','authenticated','authenticated'),
 ('00000000-0000-0000-0000-0000000000c3','nobody@test.invalid','authenticated','authenticated');
insert into public.profiles (id,email,display_name,role,tse_name) values
 ('00000000-0000-0000-0000-0000000000a1','mgr@test.invalid','Test Manager','manager',null),
 ('00000000-0000-0000-0000-0000000000b2','tse@test.invalid','Marta','tse','Marta Lindqvist');
insert into public.runs (id,push_key,source) values ('10000000-0000-0000-0000-000000000001','rls-test','fixtures');
insert into public.cases (id,run_id,case_number,owner_name) values
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','C1','Marta Lindqvist'),
 ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','C2','Daniel Osei');
insert into public.audits (id,case_id,run_id,state) values
 ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','OK'),
 ('30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','OK');
create temp table results (who text, check_name text, value text) on commit drop;
grant all on results to authenticated, anon;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
insert into results select 'manager','cases visible (expect 2)', count(*)::text from public.cases;
insert into public.review_actions (audit_id, action, reviewer_name) values ('30000000-0000-0000-0000-000000000002','approve','SPOOF');
insert into results select 'manager','review stamped as (expect Test Manager)', reviewer_name from public.review_actions;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
insert into results select 'tse','cases visible (expect Marta Lindqvist only)', string_agg(owner_name, ',') from public.cases;
insert into results select 'tse','reviews on others cases (expect 0)', count(*)::text from public.review_actions;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}';
insert into results select 'no-role','cases visible (expect 0)', count(*)::text from public.cases;
reset role;

insert into results select 'anon','can read cases (expect false)', has_table_privilege('anon','public.cases','select')::text;
select * from results;
rollback;
