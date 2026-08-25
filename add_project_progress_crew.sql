-- Run once in the Supabase SQL editor.
--
-- Thijs's ask, verbatim: "At the project, i want the same [assigned to
-- dropdown pulling HR names], but also an option to add 'casual workers'
-- (temp guys we have come in extra when we are short in hands)."
--
-- Scope confirmed via AskUserQuestion: Projects had no "assigned to" field
-- at all before this (unlike Job Cards) — the weekly progress log just
-- tracked a plain "Crew Size" number. This replaces that number with an
-- actual pick-list of who was on the crew that week: real Maintenance-
-- department staff (cross-app read of hr_employees, same source as the Job
-- Card dropdown and the Projects AI Suggestions panel) plus free-text
-- "casual worker" entries for temp labor that isn't in HR at all.
-- crew_size on project_progress_logs is unchanged in shape — it's just now
-- auto-computed from how many people are picked here, instead of typed in
-- directly, so project_workstream_status's existing avg_crew_size/
-- suggested_crew_size math needs zero changes.
--
-- Same shape/reasoning as maint_job_labor (add_job_labor_and_project_materials.sql):
-- employee_id is a soft, nullable link (never breaks a logged week's
-- history if an HR record later changes), worker_name is snapshotted at
-- log time, and casual workers are just a row with employee_id null and
-- is_casual true.
--
-- Safe to re-run: "if not exists" throughout.

create table if not exists project_progress_crew (
  id uuid primary key,
  progress_log_id uuid not null references project_progress_logs(id) on delete cascade,
  employee_id uuid,              -- soft link to hr_employees(id); null for
                                  -- casual workers, or if the row predates
                                  -- an HR record change
  worker_name text not null,     -- snapshotted at log time
  is_casual boolean not null default false,
  company_id uuid not null references companies(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_project_progress_crew_log on project_progress_crew (progress_log_id);
create index if not exists idx_project_progress_crew_company on project_progress_crew (company_id);

drop policy if exists "allow_company_project_progress_crew" on project_progress_crew;
create policy "allow_company_project_progress_crew" on project_progress_crew
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));
alter table project_progress_crew enable row level security;

-- =========================================================================
-- VERIFICATION
-- =========================================================================

select 'project_progress_crew' as table_name, count(*) as total from project_progress_crew;
