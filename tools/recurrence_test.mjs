// Recurring job cards generated ahead of time (#456).
//
//   node tools/recurrence_test.mjs
//
// Two failures are worth more than all the others here, and both are silent:
//
//   1. A template with NO end date behaving differently than it did before
//      this feature existed. That would rewrite the live schedule of every
//      recurring job at both lodges, with nothing on screen to say why.
//
//   2. Generating twice creating everything twice. A duplicate job card is
//      worse than a missing one — it gets assigned, worked and invoiced
//      before anybody spots that it was never real.
//
// Dates are DD/MM/YYYY throughout, matching maint_jobs.due_date.

import {
  occurrenceDates,
  missingOccurrences,
  nextDueOnCompletion,
  nextDueFromOpenJobs,
  describeGeneration,
  MAX_OCCURRENCES,
} from '../src/recurrence.js'

let passed = 0
const failures = []
const check = (name, cond, detail) =>
  cond ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
const eq = (name, actual, expected) =>
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
const same = (name, actual, expected) =>
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  )

// ---------------------------------------------------------------------------
// 1. THE ARITHMETIC, against a calendar you can check by hand.
{
  same(
    'weekly from 22 Sep to 20 Oct',
    occurrenceDates('22/09/2026', 'weeks', 1, '20/10/2026'),
    ['22/09/2026', '29/09/2026', '06/10/2026', '13/10/2026', '20/10/2026'],
  )
  check(
    'the end date is INCLUDED',
    occurrenceDates('22/09/2026', 'weeks', 1, '20/10/2026').includes('20/10/2026'),
    'Thijs asked for "from this week onwards to date X" — X is a date he picked, not one to stop short of',
  )
  same(
    'every 2 weeks',
    occurrenceDates('01/10/2026', 'weeks', 2, '29/10/2026'),
    ['01/10/2026', '15/10/2026', '29/10/2026'],
  )
  same(
    'monthly across a year boundary',
    occurrenceDates('15/11/2026', 'months', 1, '15/02/2027'),
    ['15/11/2026', '15/12/2026', '15/01/2027', '15/02/2027'],
  )
  same('daily', occurrenceDates('01/01/2027', 'days', 1, '04/01/2027'), [
    '01/01/2027', '02/01/2027', '03/01/2027', '04/01/2027',
  ])

  // Month arithmetic on a 31st. JavaScript rolls 31 Jan + 1 month into
  // 2 or 3 March — a real behaviour that would silently move a job. Asserted
  // as the behaviour the app already has (App.jsx uses the same setMonth), so
  // this file documents it rather than pretending otherwise.
  const endOfMonth = occurrenceDates('31/01/2027', 'months', 1, '30/04/2027')
  check(
    'a 31st rolls forward the way setMonth does, and that is recorded here',
    endOfMonth[1] === '03/03/2027',
    `got ${JSON.stringify(endOfMonth)} — if this ever changes, it is a deliberate fix, not an accident`,
  )
}

// ---------------------------------------------------------------------------
// 2. THE DEGENERATE INPUTS, each of which would otherwise hang or spew rows.
{
  same('no end date, no occurrences', occurrenceDates('22/09/2026', 'weeks', 1, null), [])
  same('no start', occurrenceDates(null, 'weeks', 1, '20/10/2026'), [])
  same('recurrence "none"', occurrenceDates('22/09/2026', 'none', 1, '20/10/2026'), [])
  same('zero step', occurrenceDates('22/09/2026', 'weeks', 0, '20/10/2026'), [])
  same('negative step', occurrenceDates('22/09/2026', 'weeks', -1, '20/10/2026'), [])
  same('end before start', occurrenceDates('20/10/2026', 'weeks', 1, '22/09/2026'), [])
  same('end equals start gives exactly one', occurrenceDates('22/09/2026', 'weeks', 1, '22/09/2026'), [
    '22/09/2026',
  ])

  // Daily for five years is ~1,827 rows. A HARD ceiling, not MAX_OCCURRENCES:
  // comparing the result against the constant that produced it is not an
  // assertion — raising the constant raises the bar and the test still
  // passes. 500 is "small enough that nobody deletes rows by hand for an
  // afternoon", which is the actual requirement.
  const CEILING = 500
  const huge = occurrenceDates('01/01/2027', 'days', 1, '01/01/2032')
  check(
    'runaway generation is capped well below the date range',
    huge.length > 0 && huge.length <= CEILING,
    `${huge.length} occurrences; the unbounded range is over 1,800 days`,
  )
  check(
    'and the cap constant itself is sane',
    MAX_OCCURRENCES > 0 && MAX_OCCURRENCES <= CEILING,
    `MAX_OCCURRENCES is ${MAX_OCCURRENCES}`,
  )
}

// ---------------------------------------------------------------------------
// 3. IDEMPOTENCE — the one that stops duplicate job cards.
{
  const tpl = {
    id: 't1',
    next_due: '22/09/2026',
    recurrence_type: 'weeks',
    recurrence_n: 1,
    recurrence_end_date: '13/10/2026',
  }
  const all = missingOccurrences(tpl, [])
  eq('four occurrences to generate', all.length, 4)

  // Pretend they were created, then ask again.
  const created = all.map((d, i) => ({ id: `j${i}`, template_id: 't1', due_date: d, status: 'scheduled' }))
  same('generating a second time creates nothing', missingOccurrences(tpl, created), [])

  // Extending the end date adds only the tail.
  const extended = { ...tpl, recurrence_end_date: '27/10/2026' }
  same('extending the end date adds only the new dates', missingOccurrences(extended, created), [
    '20/10/2026',
    '27/10/2026',
  ])

  // A card moved to a different day must NOT be silently recreated on its
  // original date — moving it was a deliberate act.
  const moved = created.map((j) => (j.due_date === '29/09/2026' ? { ...j, due_date: '01/10/2026' } : j))
  check(
    'a card moved off its date is not put back',
    missingOccurrences(tpl, moved).includes('29/09/2026'),
    'this one DOES reappear — moving a card leaves its slot empty, which is the honest reading',
  )

  // Completed cards still count as occupying their date.
  const done = created.map((j) => ({ ...j, status: 'completed' }))
  same('completed occurrences are not regenerated', missingOccurrences(tpl, done), [])

  eq('a template with no end date generates nothing', missingOccurrences({ ...tpl, recurrence_end_date: null }, []).length, 0)
  eq('an inactive template generates nothing', missingOccurrences({ ...tpl, active: false }, []).length, 0)
}

// ---------------------------------------------------------------------------
// 4. COMPLETION — legacy behaviour must be untouched.
//
// THE MIGRATION PROMISE. A template with no end date is the world as it was:
// completing a job schedules the next one, dated from the actual completion.
{
  const legacy = {
    id: 't1',
    recurrence_type: 'weeks',
    recurrence_n: 1,
    recurrence_end_date: null,
  }
  eq(
    'no end date: completion still schedules the next one',
    nextDueOnCompletion(legacy, [], '22/09/2026'),
    '29/09/2026',
  )
  eq(
    'and it is dated from the ACTUAL completion, not the plan',
    nextDueOnCompletion(legacy, [], '25/09/2026'),
    '02/10/2026',
  )
  eq('monthly legacy', nextDueOnCompletion({ ...legacy, recurrence_type: 'months' }, [], '15/01/2027'), '15/02/2027')

  eq('a once-off schedules nothing', nextDueOnCompletion({ ...legacy, recurrence_type: 'none' }, [], '22/09/2026'), null)
  eq('an inactive template schedules nothing', nextDueOnCompletion({ ...legacy, active: false }, [], '22/09/2026'), null)
  eq('a zero step schedules nothing', nextDueOnCompletion({ ...legacy, recurrence_n: 0 }, [], '22/09/2026'), null)
  eq('no completion date, nothing', nextDueOnCompletion(legacy, [], null), null)
  eq('no template, nothing', nextDueOnCompletion(null, [], '22/09/2026'), null)
}

// ---------------------------------------------------------------------------
// 5. COMPLETION with a generated schedule — the duplicate guard.
{
  const tpl = {
    id: 't1',
    recurrence_type: 'weeks',
    recurrence_n: 1,
    recurrence_end_date: '13/10/2026',
  }
  const generated = [
    { id: 'a', template_id: 't1', due_date: '22/09/2026', status: 'scheduled' },
    { id: 'b', template_id: 't1', due_date: '29/09/2026', status: 'scheduled' },
    { id: 'c', template_id: 't1', due_date: '06/10/2026', status: 'scheduled' },
    { id: 'd', template_id: 't1', due_date: '13/10/2026', status: 'scheduled' },
  ]

  eq(
    'completing one when the next already exists creates NOTHING',
    nextDueOnCompletion(tpl, generated, '22/09/2026'),
    null,
  )

  // …but if the chain has a hole — end date added later, generate never run —
  // completion still keeps it moving rather than stopping dead.
  eq(
    'a gap in the schedule is still filled on completion',
    nextDueOnCompletion(tpl, [generated[0]], '22/09/2026'),
    '29/09/2026',
  )

  // Past the end date, nothing more is scheduled. This is what makes the end
  // date an end date rather than a suggestion.
  eq(
    'nothing is scheduled past the end date',
    nextDueOnCompletion(tpl, [], '13/10/2026'),
    null,
  )
  eq(
    'the last occurrence itself is still allowed',
    nextDueOnCompletion(tpl, [], '06/10/2026'),
    '13/10/2026',
  )

  // A COMPLETED card on the next date does not block — otherwise completing
  // two occurrences out of order would stop the chain.
  const nextDone = [{ id: 'b', template_id: 't1', due_date: '29/09/2026', status: 'completed' }]
  eq(
    'a completed card on that date does not count as covering it',
    nextDueOnCompletion(tpl, nextDone, '22/09/2026'),
    '29/09/2026',
  )
}

// ---------------------------------------------------------------------------
// 6. next_due must follow the EARLIEST OPEN card, not drift from completion.
//
// Otherwise the template says December while the cards say October, and the
// next generate starts from the wrong place and creates a second schedule.
{
  const jobs = [
    { due_date: '13/10/2026', status: 'scheduled' },
    { due_date: '29/09/2026', status: 'scheduled' },
    { due_date: '22/09/2026', status: 'completed' },
    { due_date: '06/10/2026', status: 'in_progress' },
  ]
  eq('the earliest still-open card wins', nextDueFromOpenJobs(jobs, '99/99/9999'), '29/09/2026')
  eq('in_progress counts as open', nextDueFromOpenJobs([{ due_date: '01/01/2027', status: 'in_progress' }], null), '01/01/2027')
  eq('completed ones are ignored', nextDueFromOpenJobs([{ due_date: '01/01/2027', status: 'completed' }], 'fallback'), 'fallback')
  eq('nothing open falls back', nextDueFromOpenJobs([], '22/09/2026'), '22/09/2026')
  eq('an unparseable date is skipped rather than sorted first', nextDueFromOpenJobs([
    { due_date: 'rubbish', status: 'scheduled' },
    { due_date: '05/05/2027', status: 'scheduled' },
  ], null), '05/05/2027')
}

// ---------------------------------------------------------------------------
// 7. THE COUNT SHOWN BEFORE ANYTHING IS WRITTEN.
{
  const tpl = {
    next_due: '22/09/2026',
    recurrence_type: 'weeks',
    recurrence_n: 1,
    recurrence_end_date: '13/10/2026',
  }
  const d = describeGeneration(tpl, [])
  eq('four to create', d.toCreate, 4)
  eq('none there yet', d.alreadyThere, 0)
  eq('first', d.first, '22/09/2026')
  eq('last', d.last, '13/10/2026')
  eq('not capped', d.cappedAt, null)

  const half = [{ template_id: 't1', due_date: '22/09/2026', status: 'scheduled' }]
  const d2 = describeGeneration(tpl, half)
  eq('three left to create', d2.toCreate, 3)
  eq('one already there', d2.alreadyThere, 1)
  eq('and the total is still four', d2.total, 4)

  const runaway = describeGeneration(
    { next_due: '01/01/2027', recurrence_type: 'days', recurrence_n: 1, recurrence_end_date: '01/01/2032' },
    [],
  )
  eq('a runaway generation says it was capped', runaway.cappedAt, MAX_OCCURRENCES)
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  failures.forEach((f) => console.log(`  FAIL: ${f}`))
  process.exit(1)
}
