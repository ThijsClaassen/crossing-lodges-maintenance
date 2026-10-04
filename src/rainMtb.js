// Rainfall (#553) and MTB problems (#556) — the arithmetic, kept free of React
// so tools/rain_mtb_test.mjs runs it directly. 2026-10-04.

// ── Rainfall ─────────────────────────────────────────────────────────────────
// Readings are { location_id, gauge_id, reading_date: 'YYYY-MM-DD', mm }.
//
// RAIN METERS (Thijs, 2026-10-04: "I want to be able to add different rain
// meters. We have 3 meters on 1 farm"). Each reading belongs to a meter. A
// lodge's rain is the AVERAGE of its meters — three meters at 10 mm means
// 10 mm fell on the farm, not 30. Only meters that were read in the period
// count towards that average, so a meter installed in March does not drag
// January down to a third. Readings from before meters existed (no
// gauge_id) count as one meter for their lodge.

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const gaugeKey = (r) => r.gauge_id || `lodge:${r.location_id}`

const sum = (a) => a.reduce((s, x) => s + x, 0)
const round1 = (n) => Math.round(n * 10) / 10

// Rain at a lodge between two dates: the average of its meters' totals.
// { mm, meters } — meters = how many meters were read in that span.
export function lodgeRain(readings, locId, from, to) {
  const perGauge = {}
  for (const r of readings || []) {
    if (r.location_id !== locId || r.reading_date < from || r.reading_date > to) continue
    const k = gaugeKey(r)
    perGauge[k] = (perGauge[k] || 0) + (Number(r.mm) || 0)
  }
  const totals = Object.values(perGauge)
  return { mm: totals.length ? round1(sum(totals) / totals.length) : 0, meters: totals.length }
}

// Rain on one meter between two dates.
export function gaugeRain(readings, gaugeId, from, to) {
  return round1(sum((readings || []).filter((r) => gaugeKey(r) === gaugeId && r.reading_date >= from && r.reading_date <= to).map((r) => Number(r.mm) || 0)))
}

const monthSpan = (year, m) => {
  const mm = String(m + 1).padStart(2, '0')
  const last = new Date(Date.UTC(year, m + 1, 0)).getUTCDate()
  return [`${year}-${mm}-01`, `${year}-${mm}-${String(last).padStart(2, '0')}`]
}

// Month by month for one lodge in one year: each meter's own total, and the
// lodge figure (average of the meters read that month).
//   { gauges: { [gaugeKey]: [12] }, lodge: [12], meters: [12] }
export function lodgeYear(readings, locId, year, gaugeKeys) {
  const gauges = Object.fromEntries(gaugeKeys.map((k) => [k, Array(12).fill(0)]))
  const lodge = Array(12).fill(0)
  const meters = Array(12).fill(0)
  for (let m = 0; m < 12; m++) {
    const [from, to] = monthSpan(year, m)
    for (const k of gaugeKeys) gauges[k][m] = gaugeRain(readings, k, from, to)
    const r = lodgeRain(readings, locId, from, to)
    lodge[m] = r.mm
    meters[m] = r.meters
  }
  return { gauges, lodge, meters }
}

// Totals for one lodge up to `today`: this month, this calendar year to date,
// the rain season to date (South African summer-rainfall season, 1 July –
// 30 June), the same spans last year, and the last day any meter had rain.
export function rainSummary(readings, { today, locId }) {
  const y = Number(today.slice(0, 4))
  const md = today.slice(5) === '02-29' ? '02-28' : today.slice(5)
  const seasonStartYear = Number(today.slice(5, 7)) >= 7 ? y : y - 1
  const at = (from, to) => lodgeRain(readings, locId, from, to).mm
  const lastRain = (readings || []).filter((r) => r.location_id === locId && Number(r.mm) > 0 && r.reading_date <= today).map((r) => r.reading_date).sort().pop() || null
  return {
    month: at(`${today.slice(0, 7)}-01`, today),
    yearToDate: at(`${y}-01-01`, today),
    yearToDateLastYear: at(`${y - 1}-01-01`, `${y - 1}-${md}`),
    season: at(`${seasonStartYear}-07-01`, today),
    seasonLastYear: at(`${seasonStartYear - 1}-07-01`, `${y - 1}-${md}`),
    seasonLabel: `${seasonStartYear}/${String(seasonStartYear + 1).slice(2)}`,
    lastRain,
  }
}

// One reading per METER per day (the table enforces it): logging the same
// meter and day again corrects the first reading instead of adding a second.
export function existingReading(readings, { gauge_id, location_id, reading_date }) {
  const key = gauge_id || `lodge:${location_id}`
  return (readings || []).find((r) => gaugeKey(r) === key && r.reading_date === reading_date) || null
}

// ── MTB ──────────────────────────────────────────────────────────────────────
// Bikes { id, code, … }, issues { bike_id, reported_on, status, cost, … }.

// jobCosts (optional): { [jobId]: total cost } for the bike's job cards. A job
// card that fixed a logged problem already put its cost on that problem, so
// only job cards NOT tied to a problem are added on top — never twice.
export function bikeSummary(bike, issues, { jobs = [], jobCosts = {} } = {}) {
  const mine = (issues || []).filter((i) => i.bike_id === bike.id)
  const open = mine.filter((i) => i.status !== 'fixed')
  const latest = [...mine].sort((a, b) => String(b.reported_on).localeCompare(String(a.reported_on)))[0] || null
  const loose = (jobs || []).filter((j) => j.mtb_bike_id === bike.id && !j.mtb_issue_id && !mine.some((i) => i.job_id === j.id))
  return {
    problems: mine.length,
    open: open.length,
    spend: sum(mine.map((i) => Number(i.cost) || 0)) + sum(loose.map((j) => Number(jobCosts[j.id]) || 0)),
    jobs: (jobs || []).filter((j) => j.mtb_bike_id === bike.id).length,
    latest,
    // A bike with an open problem is flagged; the oldest open one says how
    // long it has been waiting.
    oldestOpen: open.map((i) => i.reported_on).sort()[0] || null,
  }
}

// Bikes in a sensible order for the list: open problems first (oldest
// waiting on top), then by code with numbers in number order (MTB 2 < MTB 10).
export function sortBikes(bikes, issues, extra) {
  return [...(bikes || [])]
    .map((b) => ({ bike: b, s: bikeSummary(b, issues, extra) }))
    .sort((a, b) =>
      (b.s.open > 0) - (a.s.open > 0) ||
      String(a.s.oldestOpen || '').localeCompare(String(b.s.oldestOpen || '')) ||
      String(a.bike.code).localeCompare(String(b.bike.code), undefined, { numeric: true, sensitivity: 'base' }),
    )
}

// Problems that keep coming back: the same words on the same bike, counted.
// Kept deliberately simple — the first three words of the problem, lower-cased.
export function repeatProblems(issues, bikeId) {
  const key = (p) => String(p || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 3).join(' ')
  const counts = {}
  for (const i of (issues || []).filter((x) => x.bike_id === bikeId)) {
    const k = key(i.problem)
    if (k) counts[k] = (counts[k] || 0) + 1
  }
  return Object.entries(counts).filter(([, n]) => n > 1).map(([text, n]) => ({ text, n })).sort((a, b) => b.n - a.n)
}

// The job card made from a bike problem: on the calendar today, at the bike's
// lodge, named so it reads on the calendar ("MTB 07: rear brake soft").
export function jobFromProblem(bike, issue, { id, companyId, dueDMY }) {
  return {
    id, company_id: companyId, location_id: bike.location_id, template_id: null,
    name: `${bike.code}: ${issue.problem}`.slice(0, 120),
    description: [issue.reported_by ? `Reported by ${issue.reported_by} on ${issue.reported_on}.` : `Reported on ${issue.reported_on}.`, bike.make_model].filter(Boolean).join(' '),
    job_type: 'reactive', destination_id: null, dest_name: null, assigned_to: null,
    due_date: dueDMY, status: 'scheduled', mtb_bike_id: bike.id, mtb_issue_id: issue.id,
  }
}
