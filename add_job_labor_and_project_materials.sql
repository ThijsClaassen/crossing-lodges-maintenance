-- Run once in the Supabase SQL editor.
--
-- Three independent additions, bundled together since they landed in the
-- same request:
--
-- 1. maint_job_labor — when a job is marked Complete, the employees who
--    worked it and how many hours each of them spent now has to be logged
--    (ticked from the on-file Maintenance-department staff list, cross-app
--    read from hr_employees). This is deliberately its own table rather
--    than reusing maint_job_materials' shape, since "who + hours" has a
--    different cardinality than "item + qty".
--
-- 2. project_progress_materials — a workstream's "+ Log" progress entry can
--    now also pull items from stock, same as a job card's Materials Used
--    section. Each row here also produces a normal maint_issues stock
--    issue at save time (done in the app, not here) so it counts against
--    inventory the same way job materials do.
--
-- 3. project_workstreams.estimate_unit — the "Your Estimate" field on a
--    workstream was locked to weeks, awkward for a 2-3 day project
--    (typing "0.4" weeks). estimate_weeks itself is UNCHANGED and stays
--    the only thing project_workstream_status (the live rate/finish-date
--    view) reads — this just remembers whether the number the person
--    typed was originally in days or weeks, so the form can round-trip
--    "3 days" instead of forcing everyone to think in weeks, and so the
--    app can show "/day" instead of "/wk" for short workstreams. Zero risk
--    to the existing view since its input column never changes shape.
--
-- Safe to re-run: "if not exists" / "if not exists" throughout.

-- 1. Job labor -----------------------------------------------------------

create table if not exists maint_job_labor (
  id uuid primary key,
  job_id uuid not null references maint_jobs(id) on delete cascade,
  employee_id uuid,              -- soft link to hr_employees(id); nullable
                                  -- so a later HR record change never
                                  -- breaks a completed job's history
  employee_name text not null,   -- snapshotted at completion time, same
                                  -- reasoning as maint_jobs.dest_name
  hours numeric not null check (hours > 0),
  company_id uuid not null references companies(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_maint_job_labor_job on maint_job_labor (job_id);
create index if not exists idx_maint_job_labor_company on maint_job_labor (company_id);

drop policy if exists "allow_company_maint_job_labor" on maint_job_labor;
create policy "allow_company_maint_job_labor" on maint_job_labor
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));
alter table maint_job_labor enable row level security;

-- 2. Workstream progress-log materials ------------------------------------

create table if not exists project_progress_materials (
  id uuid primary key,
  progress_log_id uuid not null references project_progress_logs(id) on delete cascade,
  item_id uuid not null,         -- soft link to maint_items(id), same
                                  -- loose-coupling reasoning as employee_id
                                  -- above
  qty numeric not null check (qty > 0),
  company_id uuid not null references companies(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_project_progress_materials_log on project_progress_materials (progress_log_id);
create index if not exists idx_project_progress_materials_company on project_progress_materials (company_id);

drop policy if exists "allow_company_project_progress_materials" on project_progress_materials;
create policy "allow_company_project_progress_materials" on project_progress_materials
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));
alter table project_progress_materials enable row level security;

-- 3. Days vs weeks estimate unit -------------------------------------------

alter table project_workstreams add column if not exists estimate_unit text not null default 'weeks';
alter table project_workstreams drop constraint if exists project_workstreams_estimate_unit_check;
alter table project_workstreams add constraint project_workstreams_estimate_unit_check
  check (estimate_unit in ('days','weeks'));

-- =========================================================================
-- VERIFICATION
-- =========================================================================

select 'maint_job_labor' as table_name, count(*) as total from maint_job_labor
union all select 'project_progress_materials', count(*) from project_progress_materials;

select column_name, data_type, column_default
from information_schema.columns
where table_name = 'project_workstreams' and column_name = 'estimate_unit';
