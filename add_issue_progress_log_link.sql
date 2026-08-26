-- Run once in the Supabase SQL editor.
--
-- Link stock issues back to the project progress log that caused them
-- (2026-08-26, from the full-system inspection — finding 1.3).
--
-- The problem: logging progress on a workstream can pull materials from
-- stock, which writes a maint_issues row. But that row had NO link back to
-- the log — only a free-text note ("Project: <name> — <workstream>"). So
-- deleting a progress log removed the log, its crew, its materials and its
-- internal invoice (all proper FK cascades), while the stock issue stayed
-- behind forever: stock permanently deducted, with nothing left in the
-- system explaining why, and no reliable way to find and reverse it.
--
-- This adds the missing link. Deliberately NOT "on delete cascade": the
-- app deletes these rows explicitly before deleting the log, so it can tell
-- the user exactly how many issues were reversed. "on delete set null" is
-- the safety net — if a log ever disappears by some other route, the issue
-- survives as an ordinary un-attributed issue rather than vanishing
-- silently and quietly changing historical stock figures.
--
-- Backfill note: issues written BEFORE this column existed stay null and
-- can't be matched reliably (the note text is the only clue, and workstream
-- names aren't unique). The app detects this case and tells the user which
-- issues it couldn't reverse rather than guessing. Nothing to backfill.
--
-- Safe to re-run.

alter table maint_issues
  add column if not exists progress_log_id uuid references project_progress_logs(id) on delete set null;

create index if not exists idx_maint_issues_progress_log on maint_issues (progress_log_id);

-- No RLS change needed: maint_issues' existing company-scoped policies
-- already cover this column, and it's not sensitive on its own.

-- =========================================================================
-- VERIFICATION
-- =========================================================================

select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'maint_issues' and column_name = 'progress_log_id';

-- Should be 0 rows on a fresh run (nothing linked yet), and grow as new
-- progress logs with materials are saved.
select count(*) as linked_issues from maint_issues where progress_log_id is not null;
