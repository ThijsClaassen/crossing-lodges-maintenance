-- Run once in the Supabase SQL editor.
--
-- Internal Maintenance Invoicing (2026-08-26). Thijs: "I want an invoicing
-- system so I know what our maintenance team is costing/saving us for the
-- lodges... ideally in our maintenance app we'll have like a P&L where the
-- 'invoices' going out to the lodges count as revenue, and stock/salaries
-- etc as cost."
--
-- Confirmed design (4 clarifying questions, all "Recommended" answers):
--   1. Billing rate  = each employee's own real loaded monthly cost (salary +
--      medical aid + pension + housing, same 4 fields as hr_contracts/
--      staffCostReportEngine.js) divided by a configurable "standard hours
--      per month" -> an hourly rate, NOT one blended team rate.
--   2. P&L cost side = FULL Maintenance-department cost (every active
--      Maintenance employee's real monthly cost, whether or not their hours
--      were billed that month) vs Invoiced (revenue) — the gap is the
--      unbilled/idle-capacity cost this whole feature exists to reveal.
--   3. Markup = 0%. Invoices are billed at cost, no margin.
--   4. Lives entirely inside the Maintenance app (new admin-only tab), not
--      Finance Dashboard.
--
-- Architecture notes:
--   - hr_contracts' own RLS requires is_hr_admin(company_id) to read, and a
--     Maintenance-app company admin is very often NOT an HR Admin. Direct
--     client reads of hr_contracts from this app would just return nothing.
--     So hourly-rate and department-cost lookups go through two narrow
--     SECURITY DEFINER RPCs below (get_employee_hourly_rate /
--     get_maintenance_department_cost) that read hr_employees/hr_contracts
--     internally and hand back only a computed number — never raw contract
--     fields — to anyone who already has_company_access() to that company.
--   - An invoice is generated automatically at job-completion time (in the
--     app, inside CompleteJob's save()), one row per completed job. Any
--     staff member can complete a job, so INSERT stays at the normal
--     has_company_access() level, same as every other maint_* table. But
--     the per-employee rate/cost breakdown is management-sensitive (reveals
--     real salaries indirectly), so SELECT on both new tables is
--     admin-only — same "submit but don't see everyone else's" shape
--     already used for HR-adjacent data in this codebase.
--   - Material cost reuses the exact same weightedCost() formula
--     (open_qty*open_cost + purchases) / total_qty already used by this
--     app's own Destination Costs page, computed client-side at completion
--     time — no new material-costing logic invented here.
--   - Known, deliberate gap: Maintenance's maint_issues has no `reason`
--     column (unlike Food/Beverage's write-offs), so there's no separate
--     "shrinkage" cost line — any material issued outside of a job (no
--     job_id) simply shows up as department cost with nothing invoiced
--     against it, which is arguably the right behaviour for this P&L (it
--     should surface as an unrecovered cost) but is worth knowing about.
--
-- Safe to re-run: "if not exists" throughout, policies dropped and recreated.

-- 1. Settings — one row per company, editable by admins only -------------

create table if not exists maintenance_billing_settings (
  id uuid primary key,
  company_id uuid not null unique references companies(id),
  standard_hours_per_month numeric not null default 190,
  updated_at timestamptz not null default now()
);

alter table maintenance_billing_settings enable row level security;

drop policy if exists "read_company_maintenance_billing_settings" on maintenance_billing_settings;
create policy "read_company_maintenance_billing_settings" on maintenance_billing_settings
  for select using (has_company_access(company_id));

drop policy if exists "admin_write_maintenance_billing_settings" on maintenance_billing_settings;
create policy "admin_write_maintenance_billing_settings" on maintenance_billing_settings
  for all using (
    is_platform_admin()
    or exists (select 1 from user_companies where user_id = auth.uid() and company_id = maintenance_billing_settings.company_id and role = 'admin')
  ) with check (
    is_platform_admin()
    or exists (select 1 from user_companies where user_id = auth.uid() and company_id = maintenance_billing_settings.company_id and role = 'admin')
  );

-- 2. One invoice per completed job ----------------------------------------

create table if not exists maint_job_invoices (
  id uuid primary key,
  company_id uuid not null references companies(id),
  job_id uuid not null unique references maint_jobs(id) on delete cascade,
  location_id text not null,
  destination_id uuid,           -- soft link, same convention as maint_issues
  dest_name text,                -- snapshotted at completion time
  job_name text not null,
  completed_date text not null,  -- DD/MM/YYYY, matches maint_jobs.completed_date
  labor_cost numeric not null default 0,
  material_cost numeric not null default 0,
  total_cost numeric not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_maint_job_invoices_company on maint_job_invoices (company_id);
create index if not exists idx_maint_job_invoices_location on maint_job_invoices (location_id);
create index if not exists idx_maint_job_invoices_destination on maint_job_invoices (destination_id);

alter table maint_job_invoices enable row level security;

drop policy if exists "insert_company_maint_job_invoices" on maint_job_invoices;
create policy "insert_company_maint_job_invoices" on maint_job_invoices
  for insert with check (has_company_access(company_id));

drop policy if exists "admin_read_maint_job_invoices" on maint_job_invoices;
create policy "admin_read_maint_job_invoices" on maint_job_invoices
  for select using (
    is_platform_admin()
    or exists (select 1 from user_companies where user_id = auth.uid() and company_id = maint_job_invoices.company_id and role = 'admin')
  );

drop policy if exists "admin_write_maint_job_invoices" on maint_job_invoices;
create policy "admin_write_maint_job_invoices" on maint_job_invoices
  for update using (
    is_platform_admin()
    or exists (select 1 from user_companies where user_id = auth.uid() and company_id = maint_job_invoices.company_id and role = 'admin')
  ) with check (
    is_platform_admin()
    or exists (select 1 from user_companies where user_id = auth.uid() and company_id = maint_job_invoices.company_id and role = 'admin')
  );

drop policy if exists "admin_delete_maint_job_invoices" on maint_job_invoices;
create policy "admin_delete_maint_job_invoices" on maint_job_invoices
  for delete using (
    is_platform_admin()
    or exists (select 1 from user_companies where user_id = auth.uid() and company_id = maint_job_invoices.company_id and role = 'admin')
  );

-- 3. Per-employee labor lines behind each invoice --------------------------

create table if not exists maint_job_invoice_labor_lines (
  id uuid primary key,
  invoice_id uuid not null references maint_job_invoices(id) on delete cascade,
  employee_id uuid,              -- soft link to hr_employees(id)
  employee_name text not null,   -- snapshotted, same as maint_job_labor
  hours numeric not null check (hours > 0),
  hourly_rate numeric not null default 0,
  line_cost numeric not null default 0,
  company_id uuid not null references companies(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_maint_job_invoice_labor_lines_invoice on maint_job_invoice_labor_lines (invoice_id);
create index if not exists idx_maint_job_invoice_labor_lines_company on maint_job_invoice_labor_lines (company_id);

alter table maint_job_invoice_labor_lines enable row level security;

drop policy if exists "insert_company_maint_job_invoice_labor_lines" on maint_job_invoice_labor_lines;
create policy "insert_company_maint_job_invoice_labor_lines" on maint_job_invoice_labor_lines
  for insert with check (has_company_access(company_id));

drop policy if exists "admin_read_maint_job_invoice_labor_lines" on maint_job_invoice_labor_lines;
create policy "admin_read_maint_job_invoice_labor_lines" on maint_job_invoice_labor_lines
  for select using (
    is_platform_admin()
    or exists (select 1 from user_companies where user_id = auth.uid() and company_id = maint_job_invoice_labor_lines.company_id and role = 'admin')
  );

drop policy if exists "admin_delete_maint_job_invoice_labor_lines" on maint_job_invoice_labor_lines;
create policy "admin_delete_maint_job_invoice_labor_lines" on maint_job_invoice_labor_lines
  for delete using (
    is_platform_admin()
    or exists (select 1 from user_companies where user_id = auth.uid() and company_id = maint_job_invoice_labor_lines.company_id and role = 'admin')
  );

-- 4. RPCs — narrow, computed-only windows into HR's cost data --------------
--
-- Both are SECURITY DEFINER so they can read hr_employees/hr_contracts
-- regardless of the caller's HR-admin status, but both gate on
-- has_company_access(p_company_id) first, so a caller with zero access to
-- the company gets nothing. Neither ever returns a raw contract row.

create or replace function get_employee_hourly_rate(
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
  v_hours numeric;
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

  select standard_hours_per_month into v_hours
  from maintenance_billing_settings
  where company_id = p_company_id;

  if v_hours is null or v_hours <= 0 then
    v_hours := 190;
  end if;

  return round(v_monthly / v_hours, 2);
end;
$$;

grant execute on function get_employee_hourly_rate(uuid, uuid, date) to authenticated;

create or replace function get_maintenance_department_cost(
  p_company_id uuid,
  p_as_of_date date default current_date
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total numeric;
begin
  if not has_company_access(p_company_id) then
    return null;
  end if;

  select coalesce(sum(
    coalesce(c.salary, 0)
    + coalesce(c.medical_aid_monthly_cost, 0)
    + coalesce(c.pension_fund_monthly_cost, 0)
    + coalesce(c.housing_monthly_cost, 0)
  ), 0)
  into v_total
  from hr_employees e
  join lateral (
    select *
    from hr_contracts hc
    where hc.employee_id = e.id
      and hc.company_id = p_company_id
      and hc.start_date <= p_as_of_date
    order by hc.start_date desc
    limit 1
  ) c on true
  where e.company_id = p_company_id
    and e.active = true
    and lower(trim(e.department)) = 'maintenance';

  return v_total;
end;
$$;

grant execute on function get_maintenance_department_cost(uuid, date) to authenticated;

-- =========================================================================
-- VERIFICATION
-- =========================================================================

select 'maintenance_billing_settings' as table_name, count(*) as total from maintenance_billing_settings
union all select 'maint_job_invoices', count(*) from maint_job_invoices
union all select 'maint_job_invoice_labor_lines', count(*) from maint_job_invoice_labor_lines;

select proname, pronargs from pg_proc
where proname in ('get_employee_hourly_rate', 'get_maintenance_department_cost');
