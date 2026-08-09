-- Maintenance 3c: rewrite RLS to company-scoped
-- Drops whatever policy already exists on each maint_* table (names unknown
-- since this repo has no committed schema.sql), then creates a single
-- company-scoped policy per table using the shared has_company_access()
-- helper from the Phase-1 backbone. Belt-and-braces RLS enable at the end.

do $$
declare
  pol record;
  tbl text;
begin
  foreach tbl in array array[
    'maint_items',
    'maint_destinations',
    'maint_purchases',
    'maint_issues',
    'maint_stock_counts',
    'maint_jobs',
    'maint_job_templates',
    'maint_job_materials',
    'maint_template_materials'
  ]
  loop
    for pol in select policyname from pg_policies where tablename = tbl
    loop
      execute format('drop policy if exists %I on %I', pol.policyname, tbl);
    end loop;
  end loop;
end $$;

create policy "allow_company_maint_items" on maint_items
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

create policy "allow_company_maint_destinations" on maint_destinations
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

create policy "allow_company_maint_purchases" on maint_purchases
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

create policy "allow_company_maint_issues" on maint_issues
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

create policy "allow_company_maint_stock_counts" on maint_stock_counts
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

create policy "allow_company_maint_jobs" on maint_jobs
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

create policy "allow_company_maint_job_templates" on maint_job_templates
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

create policy "allow_company_maint_job_materials" on maint_job_materials
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

create policy "allow_company_maint_template_materials" on maint_template_materials
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

alter table maint_items enable row level security;
alter table maint_destinations enable row level security;
alter table maint_purchases enable row level security;
alter table maint_issues enable row level security;
alter table maint_stock_counts enable row level security;
alter table maint_jobs enable row level security;
alter table maint_job_templates enable row level security;
alter table maint_job_materials enable row level security;
alter table maint_template_materials enable row level security;

-- Verification: run after applying, confirm exactly one allow_company_* policy per table
select tablename, policyname, cmd
from pg_policies
where tablename in (
  'maint_items','maint_destinations','maint_purchases','maint_issues',
  'maint_stock_counts','maint_jobs','maint_job_templates','maint_job_materials',
  'maint_template_materials'
)
order by tablename;
