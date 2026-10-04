// Rainfall (#553) and MTB problems (#556) — the arithmetic, kept free of React
// so tools/rain_mtb_test.mjs runs it directly. 2026-10-04.

// ── Rainfall ─────────────────────────────────────────────────────────────────
// Readings are { location_id, reading_date: 'YYYY-MM-DD', mm }.

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// mm per month (1..12) per lodge for one calendar year:
// { [locId]: [12 numbers], total: [12 numbers] }
export function monthlyGrid(readings, year, locIds) {
  const grid = Object.fromEntries(locIds.map((id) => [id, Array(12).fill(0)]))
  grid.total = Array(12).fill(0)
  for (const r of readings || []) {
    const d = String(r.reading_date || '')
    if (d.slice(0, 4) !== String(year)) continue
    const m = Number(d.slice(5, 7)) - 1
    if (!(m >= 0 && m < 12)) continue
    const mm = Number(r.mm) || 0
    if (grid[r.location_id]) grid[r.location_id][m] += mm
    grid.total[m] += mm
  }
  return grid
}

const sum = (a) => a.reduce((s, x) => s + x, 0)

// Totals for one lodge (or every lodge when locId is null) up to `today`:
// this month, this calendar year to date, the rain season to date (South
// African summer-rainfall season, 1 July – 30 June), the same span last
// year for comparison, and the last day it rained.
export function rainSummary(readings, { today, locId = null }) {
  const mine = (readings || []).filter((r) => !locId || r.location_id === locId)
  const y = Number(today.slice(0, 4))
  const md = today.slice(5)                                 // 'MM-DD'
  const seasonStartYear = Number(today.slice(5, 7)) >= 7 ? y : y - 1
  const between = (from, to) => sum(mine.filter((r) => r.reading_date >= from && r.reading_date <= to).map((r) => Number(r.mm) || 0))
  const lastRain = mine.filter((r) => Number(r.mm) > 0 && r.reading_date <= today).map((r) => r.reading_date).sort().pop() || null
  return {
    month: between(`${today.slice(0, 7)}-01`, today),
    yearToDate: between(`${y}-01-01`, today),
    yearToDateLastYear: between(`${y - 1}-01-01`, `${y - 1}-${md === '02-29' ? '02-28' : md}`),
    season: between(`${seasonStartYear}-07-01`, today),
    seasonLastYear: between(`${seasonStartYear - 1}-07-01`, `${y - 1}-${md === '02-29' ? '02-28' : md}`),
    seasonLabel: `${seasonStartYear}/${String(seasonStartYear + 1).slice(2)}`,
    lastRain,
  }
}

// One reading per lodge per day (the table enforces it): logging the same
// lodge and day again corrects the first reading instead of adding a second.
export function existingReading(readings, { location_id, reading_date }) {
  return (readings || []).find((r) => r.location_id === location_id && r.reading_date === reading_date) || null
}

// ── MTB ──────────────────────────────────────────────────────────────────────
// Bikes { id, code, … }, issues { bike_id, reported_on, status, cost, … }.

export function bikeSummary(bike, issues) {
  const mine = (issues || []).filter((i) => i.bike_id === bike.id)
  const open = mine.filter((i) => i.status !== 'fixed')
  const latest = [...mine].sort((a, b) => String(b.reported_on).localeCompare(String(a.reported_on)))[0] || null
  return {
    problems: mine.length,
    open: open.length,
    spend: sum(mine.map((i) => Number(i.cost) || 0)),
    latest,
    // A bike with an open problem is flagged; the oldest open one says how
    // long it has been waiting.
    oldestOpen: open.map((i) => i.reported_on).sort()[0] || null,
  }
}

// Bikes in a sensible order for the list: open problems first (oldest
// waiting on top), then by code with numbers in number order (MTB 2 < MTB 10).
export function sortBikes(bikes, issues) {
  return [...(bikes || [])]
    .map((b) => ({ bike: b, s: bikeSummary(b, issues) }))
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
