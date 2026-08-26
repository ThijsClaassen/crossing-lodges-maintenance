-- Run once in the Supabase SQL editor.
--
-- Extends Internal Invoicing (see add_internal_invoicing.sql) to also bill
-- Projects/workstreams labor to their lodge (2026-08-26, Thijs: "Are cost
-- for projects also being pushed through to internal billing? Same way as
-- the other? Can use full day wage for project labor cost").
--
-- Previously the Internal Billing P&L's "Gap" number unfairly counted all
-- Projects labor as unrecovered idle time, even when a crew spent a full
-- day on a legitimate project (trail building, water pipe, etc) — because
-- nothing about Projects work was ever invoiced anywhere. This closes that
-- gap (pun intended): every progress log now also generates an invoice.
--
-- Why "full day wage" instead of hourly like job cards: project_progress_logs
-- only ever captured WHO was on the crew (project_progress_crew) and a
-- qty_done figure, never hours — there's no hours field to multiply an
-- hourly rate against. A full-day rate (real monthly cost ÷ a configurable
-- "standard working days/month") avoids inventing hours that were never
-- actually recorded, and is billed once per crew member per logged entry.
--
-- Known gap: casual/temp workers (project_progress_crew.is_casual) have no
-- HR contract and therefore no tracked cost anywhere in the system — their
-- labor lines are recorded at a daily_rate of 0 (i.e. real cost exists but
-- isn't captured yet), same honest limitation as job invoicing's material
-- write-off gap.
--
-- Known gap: progress logs aren't destination-scoped (only project-level,
-- via project.location_id) — these invoices bill to a LODGE, not a specific
-- destination the way job invoices can. The Internal Billing tab's "By
-- Destination" breakdown does not include project labor for this reason;
-- see the separate "Project Labor Invoices" section instead.
--
-- Safe to re-run: "if not exists" throughout.

-- 1. New setting: standard working days/month, alongside the existing
--    standard hours/month (jobs keep using hours; projects use days). -----

alter table maintenance_billing_settings add column if not exists standard_days_per_month numeric not null default 22;

-- 2. One invoice per progress log --------------------------------------

create table if not exists project_progress_invoices (
  id uuid primary key,
  company_id uuid not null references companies(id),
  progress_log_id uuid not null unique references project_progress_logs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  workstream_id uuid not null references project_workstreams(id) on delete cascade,
  location_id text not null,
  log_date date not null,
  labor_cost numeric not null default 0,
  material_cost numeric not null default 0,
  total_cost numeric not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_project_progress_invoices_company on project_progress_invoices (company_id);
create index if not exists idx_project_progress_invoices_location on project_progress_invoices (location_id);
create index if not exists idx_project_progress_invoices_project on project_progress_invoices (project_id);

alter table project_progress_invoices enable row level security;

drop policy if exists "insert_company_project_progress_invoices" on project_progress_invoices;
create policy "insert_company_project_progress_invoices" on project_progress_invoices
  for insert with check (has_company_access(company_id));

drop policy if exists "admin_read_project_progress_invoices" on project_progress_invoices;
create policy "admin_read_project_progress_invoices" on project_progress_invoices
  for select using (
    is_platform_admin()
    or exists (select 1 from user_companies where user_id = auth.uid() and company_id = project_progress_invoices.company_id and role = 'admin')
  );

drop policy if exists "admin_write_project_progress_invoices" on project_progress_invoices;
create policy "admin_write_project_progress_invoices" on project_progress_invoices
  for update using (
    is_platform_admin()
    or exists (select 1 from user_companies where user_id = auth.uid() and company_id = project_progress_invoices.company_id and role = 'admin')
  ) with check (
    is_platform_admin()
    or exists (select 1 from user_companies where user_id = auth.uid() and company_id = project_progress_invoices.company_id and role = 'admin')
  );

drop policy if exists "admin_delete_project_progress_invoices" on project_progress_invoices;
create policy "admin_delete_project_progress_invoices" on project_progress_invoices
  for delete using (
    is_platform_admin()
    or exists (select 1 from user_companies where user_id = auth.uid() and company_id = project_progress_invoices.company_id and role = 'admin')
  );

-- 3. Per-crew-member labor lines behind each progress invoice -------------

create table if not exists project_progress_invoice_labor_lines (
  id uuid primary key,
  invoice_id uuid not null references project_progress_invoices(id) on delete cascade,
  employee_id uuid,              -- null for casual/temp workers
  employee_name text not null,
  is_casual boolean not null default false,
  daily_rate numeric not null default 0,
  line_cost numeric not null default 0,
  company_id uuid not null references companies(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_ppi_labor_lines_invoice on project_progress_invoice_labor_lines (invoice_id);
create index if not exists idx_ppi_labor_lines_company on project_progress_invoice_labor_lines (company_id);

alter table project_progress_invoice_labor_lines enable row level security;

drop policy if exists "insert_company_ppi_labor_lines" on project_progress_invoice_labor_lines;
create policy "insert_company_ppi_labor_lines" on project_progress_invoice_labor_lines
  for insert with check (has_company_access(company_id));

drop policy if exists "admin_read_ppi_labor_lines" on project_progress_invoice_labor_lines;
create policy "admin_read_ppi_labor_lines" on project_progress_invoice_labor_lines
  for select using (
    is_platform_admin()
    or exists (select 1 from user_companies where user_id = auth.uid() and company_id = project_progress_invoice_labor_lines.company_id and role = 'admin')
  );

drop policy if exists "admin_delete_ppi_labor_lines" on project_progress_invoice_labor_lines;
create policy "admin_delete_ppi_labor_lines" on project_progress_invoice_labor_lines
  for delete using (
    is_platform_admin()
    or exists (select 1 from user_companies where user_id = auth.uid() and company_id = project_progress_invoice_labor_lines.company_id and role = 'admin')
  );

-- 4. RPC — same shape/security as get_employee_hourly_rate, but divides by
--    standard_days_per_month instead of standard_hours_per_month. ---------

create or replace function get_employee_daily_rate(
  p_employee_id uuid,
  p_company_id uuid,
  p_as_of_date date default current_date
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract record;
  v_monthly numeric;
  v_days numeric;
begin
  if not has_company_access(p_company_id) then
    return null;
  end if;

  select * into v_contract
  from hr_contracts
  where employee_id = p_employee_id
    and company_id = p_company_id
    and start_date <= p_as_of_date
  order by start_date desc
  limit 1;

  if v_contract is null then
    return 0;
  end if;

  v_monthly := coalesce(v_contract.salary, 0)
             + coalesce(v_contract.medical_aid_monthly_cost, 0)
             + coalesce(v_contract.pension_fund_monthly_cost, 0)
             + coalesce(v_contract.housing_monthly_cost, 0);

  select standard_days_per_month into v_days
  from maintenance_billing_settings
  where company_id = p_company_id;

  if v_days is null or v_days <= 0 then
    v_days := 22;
  end if;

  return round(v_monthly / v_days, 2);
end;
$$;

grant execute on function get_employee_daily_rate(uuid, uuid, date) to authenticated;

-- =========================================================================
-- VERIFICATION
-- =========================================================================

select 'project_progress_invoices' as table_name, count(*) as total from project_progress_invoices
union all select 'project_progress_invoice_labor_lines', count(*) from project_progress_invoice_labor_lines;

select proname, pronargs from pg_proc where proname = 'get_employee_daily_rate';

select column_name, column_default from information_schema.columns
where table_name = 'maintenance_billing_settings' and column_name = 'standard_days_per_month';
