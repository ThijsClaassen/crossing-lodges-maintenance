// The Maintenance dashboard shows four things and no stock table.
//
// WHY (2026-09-24). Thijs: "I don't want to see the stock overview list, it's
// too much. I want to see active projects, job cards for the week we are in.
// And a counter of items that are out of stock/need to be ordered. Not the
// what, just a number. And a list of items that are out of stock but needed
// for a job that is scheduled still this week."
//
// The old page led with every stock item in one table. That list still exists
// on Stock Items and Orders; what this test protects is that it does NOT come
// back here, and that the four replacement blocks keep meaning what they say.
//
// The week maths is executed rather than pattern-matched, because "this week"
// is the part most likely to be subtly wrong — off-by-one on the Monday, or
// quietly becoming a rolling seven days, neither of which looks wrong on
// screen on the day you build it.
//
//   node tools/dashboard_test.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(ROOT, 'src', 'App.jsx'), 'utf8')

let passed = 0
const failures = []
const check = (name, cond, detail) =>
  cond ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`)

try {
  parse(src, { sourceType: 'module', plugins: ['jsx'] })
  check('App.jsx parses', true)
} catch (err) {
  console.log(`PARSE FAIL — ${err.message}`)
  process.exit(1)
}

const dash = src.slice(src.indexOf('function Dashboard('), src.indexOf('// ─── STOCK ITEMS'))
const code = dash.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

// --- what must be gone ------------------------------------------------------
check(
  'the full stock table is gone from the dashboard',
  !/Stock Overview/.test(code),
  'that table is what made the page too much to read',
)
check(
  'and it no longer maps every item into rows',
  !/items\.map\(/.test(code),
  'a per-item table is the thing being removed',
)
// The list still has to exist SOMEWHERE — removing it from the app entirely
// would be a different and much worse change than moving it off this screen.
check(
  'the item table still exists elsewhere in the app',
  /Stock Overview|<th>Code<\/th>/.test(src.replace(dash, '')),
  'it should move off the dashboard, not disappear',
)

// --- the four blocks --------------------------------------------------------
for (const [name, re] of [
  ['active projects', /Active Projects/],
  ['job cards this week', /Job Cards —/],
  ['items-to-order counter', /Items to Order/],
  ['out-of-stock blockers', /Out of Stock — Needed This Week/],
]) {
  check(`the dashboard shows ${name}`, re.test(code))
}

check(
  'the order counter is a bare number, not a list',
  /value=\{toOrderCount\}/.test(code) && !/toOrderCount\.map/.test(code),
  'Thijs asked for the number only — the detail lives on Orders',
)

// --- blockers are OUT OF STOCK, not merely low ------------------------------
check(
  'blockers filter on out-of-stock, not on the minimum level',
  /if\(!s \|\| !s\.outOfStock\) return;/.test(code),
  'an item at its minimum still has stock; it does not stop work today',
)
check(
  'and are drawn only from jobs in the week window',
  /weekJobs\.forEach/.test(code),
  'the Orders page already covers the wider two-week forecast',
)

// --- overdue work is not silently dropped -----------------------------------
check(
  'still-open overdue jobs appear in the week list',
  /const overdue = due < todayD/.test(code) && /if\(!overdue &&/.test(code),
  'a list of "this week" that hides Monday\'s unfinished job reads as all-clear',
)

// --- lodge scoping ----------------------------------------------------------
//
// jobs/items arrive pre-filtered to locId; projects and workstreams do not.
check(
  'active projects are scoped to the selected lodge',
  /p\.location_id===locId/.test(code),
  'projects are company-wide, so without this the other lodge leaks in',
)
check(
  'and the dashboard receives locId',
  /function Dashboard\(\{ locId,/.test(dash) &&
    /<Dashboard locId=\{locId\}/.test(src),
  'the filter above needs it',
)

// --- the week window, executed ----------------------------------------------
//
// Lifted out and run against real dates. A Monday-start week is easy to get
// wrong by one day, and the error only shows on one day of seven.
// THE APP'S OWN FUNCTION, executed — not a copy of it.
//
// This block previously re-implemented the Monday shift inside the test. Two
// mutations proved the point: starting the week on Sunday, and turning it into
// a rolling seven days, both left the suite green because the test was only
// checking itself. weekBounds is now exported from App.jsx and imported here,
// so there is exactly one implementation and the test can fail.
const weekSrc = src.slice(src.indexOf('export const weekBounds'), src.indexOf('// ─── DASHBOARD ───'))
const { weekBounds } = await import(
  'data:text/javascript;base64,' + Buffer.from(weekSrc).toString('base64')
)
const weekOf = (isoDate) => weekBounds(new Date(`${isoDate}T00:00:00`))

// Formatted from LOCAL parts, never toISOString(). The dates under test are
// created at local midnight, and toISOString() converts to UTC — in SAST
// (UTC+2) that rolls every start-of-week back to the Sunday and makes a
// correct implementation look off by one. The app itself is already local
// throughout (parseDMY/fmtDMY both use getDate/getMonth/getFullYear); this
// helper had to match it.
const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// 2026-09-24 is a Thursday.
{
  const w = weekOf('2026-09-24')
  check('Thursday resolves to Mon–Sun', iso(w.start) === '2026-09-21' && iso(w.end) === '2026-09-27',
    `${iso(w.start)}..${iso(w.end)}`)
}
{
  // Monday must be the START of its own week, not the end of the previous one.
  const w = weekOf('2026-09-21')
  check('Monday is the first day of its week', iso(w.start) === '2026-09-21', iso(w.start))
}
{
  // Sunday is the classic off-by-one: JS getDay() makes it 0, so a naive
  // implementation rolls it into the FOLLOWING week.
  const w = weekOf('2026-09-27')
  check('Sunday still belongs to the week that began that Monday',
    iso(w.start) === '2026-09-21' && iso(w.end) === '2026-09-27',
    `${iso(w.start)}..${iso(w.end)}`)
}
{
  // Not a rolling seven days: opening this on Friday must not reach into
  // next week.
  const w = weekOf('2026-09-25')
  check('Friday does not pull in next Tuesday', iso(w.end) === '2026-09-27', iso(w.end))
}
{
  // Month and year boundaries.
  const w = weekOf('2027-01-01') // a Friday
  check('a week can span a year boundary',
    iso(w.start) === '2026-12-28' && iso(w.end) === '2027-01-03',
    `${iso(w.start)}..${iso(w.end)}`)
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`)
  process.exit(1)
}
console.log('Dashboard shows the four blocks, no stock table, and a Mon–Sun week.\n')
