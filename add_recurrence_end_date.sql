-- Recurring job cards get an end date (#456, 2026-09-22).
--
-- Until now a recurring template held exactly ONE future job at a time:
-- completing an occurrence created the next one. Fine for "what's next",
-- useless for planning — you cannot staff a week that does not exist yet.
-- Thijs: "I would like to have all those jobs showing already ... showing
-- weekly from this week onwards to date X in December."
--
-- This column IS that date X. With it set, the app generates every occurrence
-- up to it as a real job card you can assign, move and complete individually.
--
-- ===========================================================================
-- THE MIGRATION PROMISE
--
-- NULL means "no end date", which is every template that exists today, and
-- null behaves EXACTLY as before: one job at a time, rolled forward from each
-- completion. Nothing about the live schedule at either lodge changes as a
-- result of running this. The app only generates ahead when somebody sets an
-- end date on a specific template and presses the button.
--
-- That matters more than it sounds: these rows drive who is expected where.
-- A schedule that changed without anyone asking is worse than one that
-- cannot change.
-- ===========================================================================
--
-- Safe to re-run.

alter table maint_job_templates
  add column if not exists recurrence_end_date text;

comment on column maint_job_templates.recurrence_end_date is
  'DD/MM/YYYY, matching maint_jobs.due_date and every other date in this app '
  '(text, not date — the app has used DD/MM/YYYY text throughout since it was '
  'built, and a real date column here would be the only one, needing '
  'conversion at every read). NULL = no end date = one job at a time, the '
  'pre-2026-09-22 behaviour.';


-- ===========================================================================
-- THE MIGRATION ENDS HERE. Everything below is commented out on purpose.
--
-- The Supabase SQL editor wraps a whole script in ONE transaction, so an
-- error in a verification query at the bottom rolls back the migration above
-- it and the only symptom is the error from the last statement. That has
-- happened twice on this project. A comment cannot fail. Copy one out and run
-- it on its own when you want it.
-- ===========================================================================

-- a) The column is there, and every existing template reads NULL — which is
--    the proof that nothing was invented and no schedule moved.
--
-- select count(*) as templates,
--        count(recurrence_end_date) as with_an_end_date
--   from maint_job_templates;


-- b) Recurring templates, and how far ahead each is scheduled.
--
-- select name, recurrence_type, recurrence_n, next_due, recurrence_end_date, active
--   from maint_job_templates
--  where recurrence_type <> 'none'
--  order by name;


-- c) After generating: the cards that now exist for one template, in order.
--    Replace the name. Dates are DD/MM/YYYY text, so they are sorted by their
--    parsed value rather than alphabetically — '01/12/2026' sorts before
--    '22/09/2026' as plain text, which would make this list look wrong.
--
-- select j.due_date, j.status, j.assigned_to
--   from maint_jobs j
--   join maint_job_templates t on t.id = j.template_id
--  where t.name = 'REPLACE ME'
--  order by to_date(j.due_date, 'DD/MM/YYYY');


-- d) THE DUPLICATE CHECK. Two open cards for the same template on the same
--    day means something generated twice. Should return nothing.
--
-- select template_id, due_date, count(*) as cards
--   from maint_jobs
--  where template_id is not null
--    and status in ('scheduled', 'in_progress')
--  group by template_id, due_date
-- having count(*) > 1
--  order by count(*) desc;
