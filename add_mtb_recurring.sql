-- Recurring work on a mountain bike (#562, 2026-10-08).
--
-- Thijs: "Will it also be possible to make it a recurring job card? Like we
-- can do with the Job Templates?" — so repeating bike work IS a job template,
-- linked to the bike. It then behaves exactly like any recurring job (same
-- Job Templates page; next card made on completion, or every card up to an
-- end date), and every card it makes carries the bike so it shows on the
-- bike's Job cards tab.
--
-- Run once in the Supabase SQL editor, after add_rainfall_and_mtb.sql.
-- Safe to run again. No new table, so nothing to tick under Data API.

alter table maint_job_templates
  add column if not exists mtb_bike_id uuid references mtb_bikes(id) on delete set null;

create index if not exists idx_maint_job_templates_mtb_bike on maint_job_templates(mtb_bike_id);

-- Make the API see the new column straight away.
notify pgrst, 'reload schema';

-- CHECK (shows in the results pane):
select column_name, data_type
  from information_schema.columns
 where table_name = 'maint_job_templates' and column_name = 'mtb_bike_id';
