-- Projects: "AI suggestions" layer (2026-08-19).
--
-- Adds Thijs's own gut-feel estimate per workstream ("I reckon this will
-- take about N weeks"), then extends the live project_workstream_status
-- view to compare that estimate against the actual tracked pace, and —
-- when a workstream is running behind the project deadline — suggest a
-- crew size to catch up.
--
-- Re-run note (fixes the first attempt): Postgres's CREATE OR REPLACE VIEW
-- only allows APPENDING new columns at the end of the column list — it
-- errors if any existing column's name/position shifts (that's what
-- happened the first time: avg_crew_size and estimate_weeks were inserted
-- in the middle, which silently renamed everything after them). This
-- version keeps every existing column in its original position and adds
-- estimate_weeks / estimated_finish_date / avg_crew_size /
-- suggested_crew_size only at the very end.
--
-- The crew suggestion assumes output scales roughly linearly with crew
-- size (inferred from the workstream's own logged crew_size/qty_done
-- history) — a rough guide, not a guarantee. Like the rest of this
-- module, it's a live view: nothing here is stored/written back, it's all
-- re-derived at read time from project_workstreams + project_progress_logs.
--
-- Safe to re-run.

alter table project_workstreams add column if not exists estimate_weeks numeric;

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
  end                                                as projected_finish_date,
  -- New columns appended at the end (see re-run note above) --------------
  ws.estimate_weeks,
  case
    when ws.estimate_weeks is null or ws.baseline_date is null then null
    else ws.baseline_date + (ws.estimate_weeks * 7)::int
  end                                                as estimated_finish_date,
  log_agg.avg_crew_size,
  case
    when log_agg.weeks_elapsed is null or log_agg.weeks_elapsed = 0 then null
    when log_agg.avg_crew_size is null or log_agg.avg_crew_size <= 0 then null
    when coalesce(log_agg.total_qty_done, 0) <= 0 then null
    when p.target_end_date is null then null
    when (p.target_end_date - current_date) / 7.0 <= 0 then null
    when (coalesce(log_agg.total_qty_done, 0) / log_agg.weeks_elapsed)
         >= ((ws.target_qty - (ws.baseline_qty + coalesce(log_agg.total_qty_done, 0)))
             / ((p.target_end_date - current_date) / 7.0))
      then null  -- already on track, no extra crew needed
    else ceil(
      log_agg.avg_crew_size *
      (((ws.target_qty - (ws.baseline_qty + coalesce(log_agg.total_qty_done, 0)))
        / ((p.target_end_date - current_date) / 7.0))
       / (coalesce(log_agg.total_qty_done, 0) / log_agg.weeks_elapsed))
    )
  end                                                as suggested_crew_size
from project_workstreams ws
join projects p on p.id = ws.project_id
left join lateral (
  select
    count(distinct pl.week_ending) as weeks_elapsed,
    sum(pl.qty_done)               as total_qty_done,
    sum(pl.cost_incurred)          as total_cost_incurred,
    max(pl.week_ending)            as latest_week_ending,
    avg(pl.crew_size)              as avg_crew_size
  from project_progress_logs pl
  where pl.workstream_id = ws.id
) log_agg on true;

grant select on project_workstream_status to authenticated;

-- Verification
select ws.name, ws.estimate_weeks, s.estimated_finish_date, s.projected_finish_date,
       s.avg_crew_size, s.suggested_crew_size, s.status
from project_workstream_status s
join project_workstreams ws on ws.id = s.id
order by ws.name;
