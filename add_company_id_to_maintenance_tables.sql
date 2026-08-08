-- Run once in the Supabase SQL editor.
--
-- MAINTENANCE 3a of the multi-tenant rebuild.
--
-- Same Supabase project as Finance Dashboard/Food Stock/HR-Linen/Ops
-- (confirmed 2026-08-08), so companies/user_companies/platform_admins/
-- has_company_access()/default_crossing_lodges_company_id() ALL ALREADY
-- EXIST — nothing from Phase 1 needs to be recreated.
--
-- Adds company_id to Maintenance's 9 own tables: maint_items,
-- maint_destinations, maint_purchases, maint_issues, maint_stock_counts,
-- maint_jobs, maint_job_templates (all 7 of these are per-location,
-- ZC/EC/SC), plus maint_job_materials and maint_template_materials (child
-- rows tied to a job/template by id, no location_id of their own — still
-- getting a direct company_id column, same as every other child table in
-- this project, e.g. HR/Linen's hr_uniform_stock, rather than relying on a
-- join-based RLS policy back to the parent).
--
-- Two things this app touches but does NOT own, deliberately left alone:
--   - app_access: the old shared staff/admin password table. Not
--     Maintenance-specific — 3b just stops this app from reading it, same
--     as food_access/hr_access/(Ops's continued use of) app_access.
--   - fleet: owned by Ops, already has company_id and company-scoped RLS
--     as of Ops's 3a/3c. Maintenance updates it by id (marking a vehicle
--     serviced when a job completes) — no schema change needed here, and
--     that UPDATE will already be correctly gated by fleet's own RLS.
--
-- This migration also closes the gap Ops's 3a deliberately left open:
-- Ops's syncServiceJobs() reads/writes maint_jobs without company_id today
-- (maint_jobs had no such column until this file runs). Once this lands,
-- Ops's App.jsx needs a follow-up code change — tracked separately, not
-- part of this SQL — to add company_id to those calls.
--
-- Drops the hardcoded `check (location_id in ('ZC','EC','SC'))` constraint
-- on the 7 location-scoped tables (if present) — same reasoning/decision
-- already made for Food Stock, HR/Linen, and Ops.
--
-- Safe to re-run: every statement uses "if not exists" / "if exists", and
-- every backfill only touches rows where company_id is still null.

-- 1. Add company_id (defaulted from the start) to all 9 tables -------------

alter table maint_items add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table maint_destinations add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table maint_purchases add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table maint_issues add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table maint_stock_counts add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table maint_jobs add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table maint_job_templates add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table maint_job_materials add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table maint_template_materials add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();

-- 2. Backfill every existing row to Crossing Lodges ------------------------

update maint_items set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update maint_destinations set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update maint_purchases set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update maint_issues set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update maint_stock_counts set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update maint_jobs set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update maint_job_templates set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update maint_job_materials set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update maint_template_materials set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;

-- 3. Lock it down -------------------------------------------------------------

alter table maint_items alter column company_id set not null;
alter table maint_destinations alter column company_id set not null;
alter table maint_purchases alter column company_id set not null;
alter table maint_issues alter column company_id set not null;
alter table maint_stock_counts alter column company_id set not null;
alter table maint_jobs alter column company_id set not null;
alter table maint_job_templates alter column company_id set not null;
alter table maint_job_materials alter column company_id set not null;
alter table maint_template_materials alter column company_id set not null;

-- 4. Indexes --------------------------------------------------------------------

create index if not exists idx_maint_items_company on maint_items (company_id);
create index if not exists idx_maint_destinations_company on maint_destinations (company_id);
create index if not exists idx_maint_purchases_company on maint_purchases (company_id);
create index if not exists idx_maint_issues_company on maint_issues (company_id);
create index if not exists idx_maint_stock_counts_company on maint_stock_counts (company_id);
create index if not exists idx_maint_jobs_company on maint_jobs (company_id);
create index if not exists idx_maint_job_templates_company on maint_job_templates (company_id);
create index if not exists idx_maint_job_materials_company on maint_job_materials (company_id);
create index if not exists idx_maint_template_materials_company on maint_template_materials (company_id);

-- 5. Drop the hardcoded ZC/EC/SC location check on the 7 tables that have one

alter table maint_items drop constraint if exists maint_items_location_id_check;
alter table maint_destinations drop constraint if exists maint_destinations_location_id_check;
alter table maint_purchases drop constraint if exists maint_purchases_location_id_check;
alter table maint_issues drop constraint if exists maint_issues_location_id_check;
alter table maint_stock_counts drop constraint if exists maint_stock_counts_location_id_check;
alter table maint_jobs drop constraint if exists maint_jobs_location_id_check;
alter table maint_job_templates drop constraint if exists maint_job_templates_location_id_check;

-- =========================================================================
-- VERIFICATION — run this and check "total" equals "with_company" on every
-- row.
-- =========================================================================

select 'maint_items' as table_name, count(*) as total, count(company_id) as with_company from maint_items
union all select 'maint_destinations', count(*), count(company_id) from maint_destinations
union all select 'maint_purchases', count(*), count(company_id) from maint_purchases
union all select 'maint_issues', count(*), count(company_id) from maint_issues
union all select 'maint_stock_counts', count(*), count(company_id) from maint_stock_counts
union all select 'maint_jobs', count(*), count(company_id) from maint_jobs
union all select 'maint_job_templates', count(*), count(company_id) from maint_job_templates
union all select 'maint_job_materials', count(*), count(company_id) from maint_job_materials
union all select 'maint_template_materials', count(*), count(company_id) from maint_template_materials
order by table_name;
