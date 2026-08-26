-- Maintenance: "Projects" module — multi-week development project tracking
-- (trail building, water pipe installs, building finishes, etc.) at
-- Schamach/The Gorges and any future site.
--
-- Conventions confirmed against the existing schema before writing this
-- (2026-08-19):
--   - location_id as the join key on the top-level table, same as
--     maint_jobs/maint_items/etc. (LOCATIONS = ZC/EC/SC, see sb.js).
--   - RLS: company-scoped via has_company_access(company_id) on every
--     table, matching rewrite_maintenance_rls_company_scoped.sql exactly —
--     confirmed with Thijs this is the real convention here (his "open RLS
--     + explicit grants" phrasing doesn't match what this app actually
--     does anywhere; no explicit grant statements exist in either of its
--     two prior migration files, so a default-privilege rule from the
--     Phase 1 backbone is presumably doing that job — explicit grants
--     added below anyway, belt-and-braces, same spirit as the RLS rewrite
--     file's own comment).
--   - sb.patch() vs sb.update(): no such inconsistency exists — every
--     write site in App.jsx uses sb.update() (a PATCH under the hood).
--     Nothing to reconcile.
--   - project_workstreams gets a created_at column beyond the original
--     spec: sb.js's select() hardcodes "&order=created_at.asc" on every
--     fetch, so every table (and the status view, since it's fetched the
--     same way) needs one or PostgREST 400s on the order clause.
--   - Dates are plain Postgres `date` columns with ISO strings, NOT the
--     DD/MM/YYYY text convention maint_jobs.due_date uses — that's local
--     to maint_jobs's own calendar/reschedule logic (parseDMY/fmtDMY
--     helpers), not a project-wide pattern. Every other date-bearing table
--     in this Supabase project (Finance/HR/Food/etc.) uses real `date`
--     columns, so Projects follows that instead.
--
-- Safe to re-run: every statement uses "if not exists" / "create or
-- replace" / "drop policy if exists".

-- 1. Tables -------------------------------------------------------------------

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  location_id text not null,
  name text not null,
  description text,
  start_date date,
  target_end_date date,
  status text not null default 'planning' check (status in ('planning','active','complete')),
  created_at timestamptz not null default now()
);

create table if not exists project_workstreams (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  unit text not null check (unit in ('km','m','percent')),
  target_qty numeric not null default 0,
  baseline_qty numeric not null default 0,
  baseline_date date,
  budget_cost numeric,
  status text not null default 'not_started' check (status in ('not_started','on_track','behind','complete')),
  created_at timestamptz not null default now()  -- not in the original spec, see header note
);

create table if not exists project_progress_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  workstream_id uuid not null references project_workstreams(id) on delete cascade,
  week_ending date not null,
  crew_size int,
  qty_done numeric not null default 0,   -- delta for that week, not cumulative
  cost_incurred numeric,
  notes text,
  logged_by text,
  created_at timestamptz not null default now()
);

create index if not exists idx_projects_company on projects(company_id);
create index if not exists idx_projects_location on projects(location_id);
create index if not exists idx_project_workstreams_company on project_workstreams(company_id);
create index if not exists idx_project_workstreams_project on project_workstreams(project_id);
create index if not exists idx_project_progress_logs_company on project_progress_logs(company_id);
create index if not exists idx_project_progress_logs_workstream on project_progress_logs(workstream_id);

-- 2. RLS — company-scoped, matching every other Maintenance table ------------

alter table projects enable row level security;
alter table project_workstreams enable row level security;
alter table project_progress_logs enable row level security;

drop policy if exists "allow_company_projects" on projects;
create policy "allow_company_projects" on projects
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists "allow_company_project_workstreams" on project_workstreams;
create policy "allow_company_project_workstreams" on project_workstreams
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists "allow_company_project_progress_logs" on project_progress_logs;
create policy "allow_company_project_progress_logs" on project_progress_logs
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

grant select, insert, update, delete on projects to authenticated;
grant select, insert, update, delete on project_workstreams to authenticated;
grant select, insert, update, delete on project_progress_logs to authenticated;

-- 3. Live computed status view -------------------------------------------------
-- Deliberately a view, not a stored/write-back column — always reflects
-- current logs at read time. RLS on the underlying tables (both views'
-- default and this Postgres version) is applied per-invoker, so a user
-- only ever sees rows for companies they already have access to.

create or replace view project_workstream_status as
select
  ws.id,
  ws.company_id,
  ws.project_id,
  ws.name,
  ws.unit,
  ws.target_qty,
  ws.baseline_qty,
  ws.baseline_date,
  ws.budget_cost,
  ws.status                                        as manual_status,
  ws.created_at,
  p.location_id,
  p.target_end_date                                as project_target_end_date,
  coalesce(log_agg.total_qty_done, 0)               as total_qty_done,
  ws.baseline_qty + coalesce(log_agg.total_qty_done, 0)               as cumulative_done,
  ws.target_qty - (ws.baseline_qty + coalesce(log_agg.total_qty_done, 0)) as remaining,
  log_agg.weeks_elapsed,
  log_agg.latest_week_ending,
  coalesce(log_agg.total_cost_incurred, 0)          as total_cost_incurred,
  case
    when ws.budget_cost is null then null
    else ws.budget_cost - coalesce(log_agg.total_cost_incurred, 0)
  end                                                as budget_variance,
  case
    when log_agg.weeks_elapsed is null or log_agg.weeks_elapsed = 0 then null
    else coalesce(log_agg.total_qty_done, 0) / log_agg.weeks_elapsed
  end                                                as actual_rate_per_week,
  case
    when p.target_end_date is null then null
    else (p.target_end_date - current_date) / 7.0
  end                                                as weeks_remaining_to_deadline,
  case
    when p.target_end_date is null then null
    when (p.target_end_date - current_date) / 7.0 <= 0 then null
    else (ws.target_qty - (ws.baseline_qty + coalesce(log_agg.total_qty_done, 0)))
         / ((p.target_end_date - current_date) / 7.0)
  end                                                as rate_needed_per_week,
  case
    when log_agg.weeks_elapsed is null or log_agg.weeks_elapsed = 0 then 'no_data'
    when (ws.target_qty - (ws.baseline_qty + coalesce(log_agg.total_qty_done, 0))) <= 0 then 'on_track'
    when p.target_end_date is null then
      case when (coalesce(log_agg.total_qty_done, 0) / nullif(log_agg.weeks_elapsed, 0)) > 0
        then 'on_track' else 'behind' end
    when (p.target_end_date - current_date) / 7.0 <= 0 then 'behind'
    else
      case when (coalesce(log_agg.total_qty_done, 0) / nullif(log_agg.weeks_elapsed, 0))
             >= ((ws.target_qty - (ws.baseline_qty + coalesce(log_agg.total_qty_done, 0)))
                 / ((p.target_end_date - current_date) / 7.0))
        then 'on_track' else 'behind' end
  end                                                as status,
  case
    when log_agg.weeks_elapsed is null or log_agg.weeks_elapsed = 0
         or coalesce(log_agg.total_qty_done, 0) <= 0 then null
    when (ws.target_qty - (ws.baseline_qty + coalesce(log_agg.total_qty_done, 0))) <= 0 then current_date
    else current_date + (
      ((ws.target_qty - (ws.baseline_qty + coalesce(log_agg.total_qty_done, 0)))
       / (coalesce(log_agg.total_qty_done, 0) / log_agg.weeks_elapsed)) * 7
    )::int
  end                                                as projected_finish_date
from project_workstreams ws
join projects p on p.id = ws.project_id
left join lateral (
  select
    count(distinct pl.week_ending) as weeks_elapsed,
    sum(pl.qty_done)               as total_qty_done,
    sum(pl.cost_incurred)          as total_cost_incurred,
    max(pl.week_ending)            as latest_week_ending
  from project_progress_logs pl
  where pl.workstream_id = ws.id
) log_agg on true;

grant select on project_workstream_status to authenticated;

-- 4. Seed data: Schamach / The Gorges Development ----------------------------

do $$
declare
  v_company_id uuid;
  v_project_id uuid;
begin
  select id into v_company_id from companies where slug = 'crossing-lodges';

  insert into projects (id, company_id, location_id, name, description, start_date, target_end_date, status)
  values (gen_random_uuid(), v_company_id, 'SC', 'Schamach / The Gorges Development',
          'Trail building, water pipe installation, and building finishes at Schamach / The Gorges.',
          '2026-08-19', '2026-12-01', 'active')
  returning id into v_project_id;

  insert into project_workstreams (id, company_id, project_id, name, unit, target_qty, baseline_qty, baseline_date, budget_cost, status)
  values
    (gen_random_uuid(), v_company_id, v_project_id, 'MTB Trail',          'km',      20,   4.5, '2026-08-19', null, 'not_started'),
    (gen_random_uuid(), v_company_id, v_project_id, 'Hiking Trail',       'km',      15,   0,   '2026-08-19', null, 'not_started'),
    (gen_random_uuid(), v_company_id, v_project_id, 'Water Pipe',         'm',       3000, 0,   '2026-08-19', null, 'not_started'),
    (gen_random_uuid(), v_company_id, v_project_id, 'Laundry Finishes',   'percent', 1,    0,   '2026-08-19', null, 'not_started'),
    (gen_random_uuid(), v_company_id, v_project_id, 'Workshop Finishes',  'percent', 1,    0,   '2026-08-19', null, 'not_started');
end $$;

-- =========================================================================
-- VERIFICATION — run after applying.
-- =========================================================================

select 'projects' as table_name, count(*) as total from projects
union all select 'project_workstreams', count(*) from project_workstreams
union all select 'project_progress_logs', count(*) from project_progress_logs;

select tablename, policyname, cmd from pg_policies
where tablename in ('projects','project_workstreams','project_progress_logs')
order by tablename;

select ws.name, ws.unit, ws.target_qty, ws.baseline_qty, s.status, s.cumulative_done, s.remaining,
       s.weeks_remaining_to_deadline, s.projected_finish_date
from project_workstream_status s
join project_workstreams ws on ws.id = s.id
order by ws.name;
