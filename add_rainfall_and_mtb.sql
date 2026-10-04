-- Maintenance: rainfall log (#553) and MTB problem tracking (#556) — 2026-10-04.
--
-- Thijs: "Maintenance, add a section where we save rain fall." and "MTB
-- section … where we can keep track of problems per mountain bike" (in the
-- Maintenance app).
--
-- Run once in the Supabase SQL editor. Safe to run again.
-- THREE NEW TABLES: after running, expose them under Settings › API › Data API
-- (maint_rainfall, mtb_bikes, mtb_issues), as with every new table.
--
-- Conventions as the rest of the Maintenance app (add_maintenance_projects.sql):
-- company_id + location_id, real `date` columns, a created_at on every table
-- (sb.select orders by it), RLS has_company_access, explicit grants. Plus the
-- roles-step-5 rule: only people with the Maintenance app (or no apps ticked,
-- or Owners) may write them.

-- 1. Rainfall -------------------------------------------------------------------
create table if not exists maint_rainfall (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  location_id text not null,
  reading_date date not null,
  mm numeric not null check (mm >= 0),
  notes text,
  recorded_by text,
  created_at timestamptz not null default now(),
  -- One reading per lodge per day; a second entry for the same day corrects
  -- the first rather than doubling it (the app updates in that case).
  unique (company_id, location_id, reading_date)
);
create index if not exists idx_maint_rainfall_company_date on maint_rainfall(company_id, reading_date);

-- 2. Mountain bikes and their problems ---------------------------------------------
create table if not exists mtb_bikes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  location_id text not null,
  code text not null,                 -- what is painted on the bike, e.g. "MTB 07"
  make_model text,
  frame_size text,
  serial_number text,
  purchase_date date,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists idx_mtb_bikes_company on mtb_bikes(company_id);

create table if not exists mtb_issues (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  bike_id uuid not null references mtb_bikes(id) on delete cascade,
  reported_on date not null,
  problem text not null,
  reported_by text,
  status text not null default 'open' check (status in ('open', 'fixed')),
  fixed_on date,
  fix_notes text,
  cost numeric check (cost is null or cost >= 0),
  created_at timestamptz not null default now()
);
create index if not exists idx_mtb_issues_company on mtb_issues(company_id);
create index if not exists idx_mtb_issues_bike on mtb_issues(bike_id);

-- 3. Row rules -------------------------------------------------------------------------
alter table maint_rainfall enable row level security;
alter table mtb_bikes enable row level security;
alter table mtb_issues enable row level security;

drop policy if exists "allow_company_maint_rainfall" on maint_rainfall;
create policy "allow_company_maint_rainfall" on maint_rainfall
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));
drop policy if exists "allow_company_mtb_bikes" on mtb_bikes;
create policy "allow_company_mtb_bikes" on mtb_bikes
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));
drop policy if exists "allow_company_mtb_issues" on mtb_issues;
create policy "allow_company_mtb_issues" on mtb_issues
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

grant select, insert, update, delete on maint_rainfall to authenticated;
grant select, insert, update, delete on mtb_bikes to authenticated;
grant select, insert, update, delete on mtb_issues to authenticated;

-- Roles step 5: writes only from the Maintenance app. Only if step 5 has run
-- (can_write_app exists); otherwise these tables simply follow the rule above.
do $$
declare t text;
begin
  if to_regprocedure('can_write_app(uuid, text[])') is null then return; end if;
  foreach t in array array['maint_rainfall', 'mtb_bikes', 'mtb_issues'] loop
    execute format('drop policy if exists app_scope_insert on %I', t);
    execute format('drop policy if exists app_scope_update on %I', t);
    execute format('drop policy if exists app_scope_delete on %I', t);
    execute format('create policy app_scope_insert on %I as restrictive for insert to authenticated with check (can_write_app(company_id, ''{maintenance}''::text[]))', t);
    execute format('create policy app_scope_update on %I as restrictive for update to authenticated using (can_write_app(company_id, ''{maintenance}''::text[])) with check (can_write_app(company_id, ''{maintenance}''::text[]))', t);
    execute format('create policy app_scope_delete on %I as restrictive for delete to authenticated using (can_write_app(company_id, ''{maintenance}''::text[]))', t);
  end loop;
end $$;

-- THE MIGRATION ENDS HERE. Everything below is commented out on purpose.
--
-- CHECK:
--   select tablename, policyname from pg_policies
--    where tablename in ('maint_rainfall', 'mtb_bikes', 'mtb_issues') order by 1, 2;
--   -- expect allow_company_… plus app_scope_insert/update/delete on each.
