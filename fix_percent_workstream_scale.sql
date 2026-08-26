-- Fixes the seeded percent-unit workstreams, which were seeded under the
-- old (wrong) assumption that percent quantities are stored as 0-1
-- fractions (target_qty=1 meaning "100%"). The app has been fixed to
-- treat percent quantities as plain 0-100 numbers instead (matching how
-- people naturally type them into the Target Qty / Qty Done fields), so
-- these two rows need their target_qty corrected from 1 to 100 to match.
-- baseline_qty (0 either way) doesn't need touching.
--
-- Only Laundry Finishes and Workshop Finishes are percent-unit in the
-- original seed — safe to re-run, only touches rows still at the old
-- value.

update project_workstreams
set target_qty = 100
where unit = 'percent'
  and target_qty = 1
  and name in ('Laundry Finishes', 'Workshop Finishes');

-- Verification
select ws.name, ws.unit, ws.target_qty, ws.baseline_qty
from project_workstreams ws
where ws.unit = 'percent'
order by ws.name;
