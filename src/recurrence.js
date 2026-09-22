// Recurring job cards, generated ahead of time (#456, 2026-09-22).
//
// Until now a recurring template held exactly ONE future job at a time:
// completing an occurrence created the next one, dated from the actual
// completion date. That is fine for "what's next" and useless for planning —
// you cannot staff a week that does not exist yet. Thijs: "If we add Job
// cards that are recurring, I would like to have all those jobs showing
// already, this is important for me to be able to create a proper schedule
// upfront ... showing weekly from this week onwards to date X in December."
//
// So a template gains an END DATE, and every occurrence up to it becomes a
// real job card you can assign, move and complete individually.
//
// THE PROPERTY THAT MATTERS MOST, and the reason for the shape below: a
// template with NO end date must behave exactly as it did before this file
// existed. Null end date is the old world, unchanged. Anything else means
// deploying this silently rewrites the schedule of every recurring job at
// both lodges.
//
// THE SECOND PROPERTY: generating twice must not create anything twice.
// Somebody will press the button again, or edit the template and re-save, and
// a duplicate job card is worse than a missing one — it gets assigned, worked
// and invoiced before anybody notices it was never real.
//
// Dates here are DD/MM/YYYY strings, matching maint_jobs.due_date and the
// rest of this app. The helpers are duplicated from App.jsx rather than
// imported from it because App.jsx is a 5,000-line component file with no
// exports; keeping them here lets the arithmetic be tested against known
// calendars instead of eyeballed on a grid (tools/recurrence_test.mjs).

export const MAX_OCCURRENCES = 400

export function parseDMY(s) {
  if (!s) return null
  const [d, m, y] = String(s).split('/').map(Number)
  if (!d || !m || !y) return null
  const dt = new Date(y, m - 1, d)
  return Number.isFinite(dt.getTime()) ? dt : null
}

export function fmtDMY(dt) {
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`
}

export function addPeriod(dt, type, n) {
  const d = new Date(dt.getTime())
  if (type === 'days') d.setDate(d.getDate() + n)
  if (type === 'weeks') d.setDate(d.getDate() + n * 7)
  if (type === 'months') d.setMonth(d.getMonth() + n)
  return d
}

// Every occurrence from `startDMY` (inclusive) to `endDMY` (inclusive).
//
// Capped at MAX_OCCURRENCES. A daily job running to next December is 400+
// cards, and silently generating them is how somebody ends up deleting rows
// by hand for an afternoon. The caller is expected to show the count before
// writing anything.
export function occurrenceDates(startDMY, type, n, endDMY) {
  const start = parseDMY(startDMY)
  const end = parseDMY(endDMY)
  const step = Number(n) || 0
  if (!start || !end || !type || type === 'none' || step <= 0) return []
  if (end < start) return []

  const out = []
  let cursor = start
  while (cursor <= end && out.length < MAX_OCCURRENCES) {
    out.push(fmtDMY(cursor))
    const next = addPeriod(cursor, type, step)
    // A period that does not advance the date would spin forever. Cannot
    // happen with step > 0 and a known type, but this function is also the
    // one a future unit type would flow through.
    if (next <= cursor) break
    cursor = next
  }
  return out
}

// Which occurrences do NOT yet have a job card.
//
// Keyed on the date string, so pressing Generate twice is a no-op and editing
// a template's end date only ever adds the new tail. A card the user moved to
// a different day counts as that day, not its original one — which is right:
// moving a card is a deliberate act, and regenerating should not quietly put
// the original back.
export function missingOccurrences(template, jobsForTemplate = []) {
  if (!template) return []
  if (!template.recurrence_end_date) return []
  if (template.active === false) return []
  const dates = occurrenceDates(
    template.next_due,
    template.recurrence_type,
    template.recurrence_n,
    template.recurrence_end_date,
  )
  const taken = new Set(jobsForTemplate.map((j) => j.due_date))
  return dates.filter((d) => !taken.has(d))
}

// On completing an occurrence, what (if anything) should be scheduled next?
// Returns a DD/MM/YYYY date, or null for "create nothing".
//
// Null in every one of these cases:
//   - not a recurring template, or it has been deactivated;
//   - the next date would fall past the template's end date;
//   - a job card already exists for that date — the schedule was generated
//     ahead of time and the next one is already sitting there.
//
// That last rule is what stops pre-generated schedules growing a duplicate
// every time somebody finishes a job. It also quietly fixes the same bug for
// templates with no end date: previously completion created the next card
// unconditionally, so a manually-added card on that date became two.
export function nextDueOnCompletion(template, jobsForTemplate = [], completedDMY) {
  if (!template) return null
  if (template.active === false) return null
  if (!template.recurrence_type || template.recurrence_type === 'none') return null
  const step = Number(template.recurrence_n) || 0
  if (step <= 0) return null

  const completed = parseDMY(completedDMY)
  if (!completed) return null

  const next = addPeriod(completed, template.recurrence_type, step)
  const nextDMY = fmtDMY(next)

  if (template.recurrence_end_date) {
    const end = parseDMY(template.recurrence_end_date)
    if (end && next > end) return null
  }

  // An OPEN card on that date already covers it. A completed or cancelled one
  // does not — re-completing a date should still move the chain forward.
  const alreadyThere = jobsForTemplate.some(
    (j) => j.due_date === nextDMY && (j.status === 'scheduled' || j.status === 'in_progress'),
  )
  if (alreadyThere) return null

  return nextDMY
}

// The template's next_due after completing one, given the cards that exist.
//
// With a generated schedule, next_due should follow the EARLIEST card still
// open, not drift from whenever somebody happened to finish. Otherwise the
// template says December while the cards say October, and the next generate
// starts from the wrong place.
export function nextDueFromOpenJobs(jobsForTemplate = [], fallbackDMY = null) {
  const open = jobsForTemplate
    .filter((j) => j.status === 'scheduled' || j.status === 'in_progress')
    .map((j) => ({ dmy: j.due_date, at: parseDMY(j.due_date) }))
    .filter((j) => j.at)
    .sort((a, b) => a.at - b.at)
  return open.length ? open[0].dmy : fallbackDMY
}

// One line describing what generating will do, for the confirm step. Written
// so the reader knows the count BEFORE the rows exist, not after.
export function describeGeneration(template, jobsForTemplate = []) {
  const missing = missingOccurrences(template, jobsForTemplate)
  const all = template?.recurrence_end_date
    ? occurrenceDates(
        template.next_due,
        template.recurrence_type,
        template.recurrence_n,
        template.recurrence_end_date,
      )
    : []
  return {
    toCreate: missing.length,
    alreadyThere: all.length - missing.length,
    total: all.length,
    first: missing[0] || null,
    last: missing.length ? missing[missing.length - 1] : null,
    cappedAt: all.length >= MAX_OCCURRENCES ? MAX_OCCURRENCES : null,
  }
}
