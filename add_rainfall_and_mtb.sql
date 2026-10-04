-- Maintenance: rainfall log (#553) and MTB problem tracking (#556) — 2026-10-04.
-- Revised the same day for Thijs's follow-up:
--   "At the rainfall, I want to be able to add different rain meters. We have
--    3 meters on 1 farm for example."
--   "MTB, must also be linked to the stock and calendar. Link MTB's to
--    jobcard when work is being done on MTB's."
--
-- Run once in the Supabase SQL editor. Safe to run again — and safe whether
-- or not the first version of this file was already run (everything is
-- "if not exists" / add-if-missing).
--
-- NEW TABLES: after running, expose them under Settings › API › Data API:
--   maint_rain_gauges, maint_rainfall, mtb_bikes, mtb_issues.
--
-- Conventions as the rest of the Maintenance app: company_id + location_id,
-- real `date` columns, a created_at on every table (sb.select orders by it),
-- RLS has_company_access, explicit grants, and the roles-step-5 rule that
-- only the Maintenance app may write them.

-- 1. Rain meters and readings ----------------------------------------------------
-- A lodge or farm can have several meters (3 on one farm). Each reading
-- belongs to one meter; the lodge's rain is the AVERAGE of its meters, not
-- the sum (three meters at 10 mm = 10 mm of rain), worked out in the app.
create table if not exists maint_rain_gauges (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  location_id text not null,
  name text not null,                 -- e.g. "Homestead", "North camp", "Dam wall"
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_maint_rain_gauges_company on maint_rain_gauges(company_id);

create table if not exists maint_rainfall (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  location_id text not null,
  reading_date date not null,
  mm numeric not null check (mm >= 0),
  notes text,
  recorded_by text,
  created_at timestamptz not null default now()
);
alter table maint_rainfall add column if not exists gauge_id uuid references maint_rain_gauges(id) on delete restrict;
create index if not exists idx_maint_rainfall_company_date on maint_rainfall(company_id, reading_date);

-- One reading per METER per day (was: per lodge per day in the first
-- version). A second entry for the same meter and day corrects the first.
-- Readings from before meters existed (no gauge) keep one per lodge per day.
alter table maint_rainfall drop constraint if exists maint_rainfall_company_id_location_id_reading_date_key;
create unique index if not exists maint_rainfall_one_per_gauge_day
  on maint_rainfall (company_id, coalesce(gauge_id::text, 'lodge:' || location_id), reading_date);

-- 2. Mountain bikes, their problems, and the job-card link ---------------------------
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

-- The work on a bike is a job card: it sits on the calendar, and its stock
-- goes out through the job card's materials like any other job. The job
-- carries the bike (and the problem it fixes); the problem carries its job.
alter table mtb_issues add column if not exists job_id uuid references maint_jobs(id) on delete set null;
alter table maint_jobs add column if not exists mtb_bike_id uuid references mtb_bikes(id) on delete set null;
alter table maint_jobs add column if not exists mtb_issue_id uuid references mtb_issues(id) on delete set null;
create index if not exists idx_maint_jobs_mtb_bike on maint_jobs(mtb_bike_id);

-- 3. Row rules -------------------------------------------------------------------------
alter table maint_rain_gauges enable row level security;
alter table maint_rainfall enable row level security;
alter table mtb_bikes enable row level security;
alter table mtb_issues enable row level security;

drop policy if exists "allow_company_maint_rain_gauges" on maint_rain_gauges;
create policy "allow_company_maint_rain_gauges" on maint_rain_gauges
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));
drop policy if exists "allow_company_maint_rainfall" on maint_rainfall;
create policy "allow_company_maint_rainfall" on maint_rainfall
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));
drop policy if exists "allow_company_mtb_bikes" on mtb_bikes;
create policy "allow_company_mtb_bikes" on mtb_bikes
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));
drop policy if exists "allow_company_mtb_issues" on mtb_issues;
create policy "allow_company_mtb_issues" on mtb_issues
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

grant select, insert, update, delete on maint_rain_gauges to authenticated;
grant select, insert, update, delete on maint_rainfall to authenticated;
grant select, insert, update, delete on mtb_bikes to authenticated;
grant select, insert, update, delete on mtb_issues to authenticated;

-- Roles step 5: writes only from the Maintenance app. Only if step 5 has run
-- (can_write_app exists); otherwise these tables simply follow the rule above.
do $$
declare t text;
begin
  if to_regprocedure('can_write_app(uuid, text[])') is null then return; end if;
  foreach t in array array['maint_rain_gauges', 'maint_rainfall', 'mtb_bikes', 'mtb_issues'] loop
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
--    where tablename in ('maint_rain_gauges', 'maint_rainfall', 'mtb_bikes', 'mtb_issues') order by 1, 2;
--   select column_name from information_schema.columns
--    where table_name = 'maint_jobs' and column_name like 'mtb_%';   -- mtb_bike_id, mtb_issue_id
