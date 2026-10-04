// rain_mtb_test.mjs — rainfall log (#553) and MTB problems (#556), 2026-10-04.
//
//   node tools/rain_mtb_test.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
const failures = []
const check = (name, ok, detail) => (ok ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`))
const R = await import(pathToFileURL(join(ROOT, 'src', 'rainMtb.js')).href)

// ── Rainfall ───────────────────────────────────────────────────────────────
const rain = [
  { location_id: 'ZC', reading_date: '2025-07-15', mm: 4 },     // last season
  { location_id: 'ZC', reading_date: '2025-10-02', mm: 10 },    // last year, same span
  { location_id: 'ZC', reading_date: '2026-01-20', mm: 30 },
  { location_id: 'ZC', reading_date: '2026-07-03', mm: 2 },     // this season
  { location_id: 'ZC', reading_date: '2026-10-01', mm: 12.5 },
  { location_id: 'ZC', reading_date: '2026-10-03', mm: 0 },     // dry gauge check
  { location_id: 'EC', reading_date: '2026-10-02', mm: 20 },
]
const g = R.monthlyGrid(rain, 2026, ['ZC', 'EC'])
check('grid: October ZC = 12.5 + 0', g.ZC[9] === 12.5)
check('grid: October all lodges adds the gauges (12.5 + 20)', g.total[9] === 32.5)
check('grid: other years left out', g.ZC[6] === 2 && g.total.reduce((s, x) => s + x, 0) === 64.5)
check('grid: a lodge not asked for still counts in the total but gets no column', R.monthlyGrid([{ location_id: 'XX', reading_date: '2026-03-01', mm: 5 }], 2026, ['ZC']).total[2] === 5)

const s = R.rainSummary(rain, { today: '2026-10-04', locId: 'ZC' })
check('this month at ZC: 12.5', s.month === 12.5)
check('year to date at ZC: 30 + 2 + 12.5', s.yearToDate === 44.5)
check('same span last year: up to 4 Oct 2025 (4 + 10)', s.yearToDateLastYear === 14)
check('rain season starts 1 July: 2 + 12.5', s.season === 14.5, String(s.season))
check('last season to the same day: 1 Jul 2025 – 4 Oct 2025 (4 + 10)', s.seasonLastYear === 14)
check('season label', s.seasonLabel === '2026/27')
check('last rain ignores a 0 mm gauge check', s.lastRain === '2026-10-01')
check('in June the season is the one that started last July', R.rainSummary(rain, { today: '2026-06-30', locId: 'ZC' }).seasonLabel === '2025/26')
check('all lodges when no lodge is given', R.rainSummary(rain, { today: '2026-10-04' }).month === 32.5)
check('29 Feb compares against 28 Feb last year without breaking', typeof R.rainSummary(rain, { today: '2028-02-29' }).yearToDateLastYear === 'number')
check('one reading per lodge per day: a second entry finds the first', R.existingReading(rain, { location_id: 'ZC', reading_date: '2026-10-01' })?.mm === 12.5 && R.existingReading(rain, { location_id: 'EC', reading_date: '2026-10-01' }) === null)

// ── MTB ────────────────────────────────────────────────────────────────────
const bikes = [{ id: 'b10', code: 'MTB 10' }, { id: 'b2', code: 'MTB 2' }, { id: 'b5', code: 'MTB 5' }]
const issues = [
  { bike_id: 'b10', reported_on: '2026-09-01', problem: 'Rear brake soft', status: 'fixed', cost: 150 },
  { bike_id: 'b10', reported_on: '2026-09-20', problem: 'rear brake soft again', status: 'open' },
  { bike_id: 'b5', reported_on: '2026-08-15', problem: 'Chain skips', status: 'open', cost: null },
  { bike_id: 'b5', reported_on: '2026-07-01', problem: 'Puncture front', status: 'fixed', cost: 80 },
]
const s10 = R.bikeSummary(bikes[0], issues)
check('summary: problems, open, spend, latest, oldest open', s10.problems === 2 && s10.open === 1 && s10.spend === 150 && s10.latest.reported_on === '2026-09-20' && s10.oldestOpen === '2026-09-20')
const order = R.sortBikes(bikes, issues).map((x) => x.bike.code).join(',')
check('list order: open problems first, longest waiting on top; then by number (2 before 10)', order === 'MTB 5,MTB 10,MTB 2', order)
check('repeat problems: "rear brake soft" twice on MTB 10', R.repeatProblems(issues, 'b10')[0]?.text === 'rear brake soft' && R.repeatProblems(issues, 'b10')[0]?.n === 2)
check('no repeats on a bike with different problems', R.repeatProblems(issues, 'b5').length === 0)

// ── SQL and wiring ─────────────────────────────────────────────────────────
const sql = readFileSync(join(ROOT, 'add_rainfall_and_mtb.sql'), 'utf8')
const body = sql.slice(0, sql.indexOf('THE MIGRATION ENDS HERE'))
check('SQL: three tables, one rainfall reading per lodge per day, issues cascade with their bike', /create table if not exists maint_rainfall/.test(body) && /unique \(company_id, location_id, reading_date\)/.test(body) && /references mtb_bikes\(id\) on delete cascade/.test(body))
check('SQL: every table has created_at (sb.select orders by it) and company RLS + grants', ['maint_rainfall', 'mtb_bikes', 'mtb_issues'].every((t) => new RegExp(`create policy "allow_company_${t}"`).test(body) && new RegExp(`grant select, insert, update, delete on ${t} to authenticated`).test(body)) && (body.match(/created_at timestamptz not null default now\(\)/g) || []).length === 3)
check('SQL: roles step 5 rule applied when present (Maintenance writes only)', /to_regprocedure\('can_write_app\(uuid, text\[\]\)'\) is null/.test(body) && /as restrictive for insert/.test(body))
check('SQL: marker present, nothing live after it', !/^\s*(create|alter|drop|grant|do)\b/m.test(sql.slice(sql.indexOf('THE MIGRATION ENDS HERE')).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')))

const app = readFileSync(join(ROOT, 'src', 'App.jsx'), 'utf8')
check('menu: MTB and Rainfall under "Assets", open to everyone', /\{id:"mtb",\s+label:"MTB",\s+section:"Assets",\s+adminOnly:false\}/.test(app) && /\{id:"rainfall",\s+label:"Rainfall",\s+section:"Assets",\s+adminOnly:false\}/.test(app))
check('pages routed', /page==="mtb"\s+&& <MtbPage /.test(app) && /page==="rainfall"\s+&& <RainfallPage /.test(app))
check('rainfall: a second reading for the same lodge and day replaces the first', /const existing = existingReading\(all, form\);[\s\S]{0,200}if \(existing\) \{\s*await sb\.update\("maint_rainfall"/.test(app))
check('MTB: adding / editing / retiring a bike is admin-only; logging and fixing problems is for everyone', /\{isAdmin && <button className="btn btn-primary" onClick=\{\(\) => setNewBike/.test(app) && /disabled=\{!isAdmin\}/.test(app) && /onClick=\{logProblem\}/.test(app) && !/isAdmin && <button[^>]*logProblem/.test(app))
check('both pages explain a missing table instead of failing', /run add_rainfall_and_mtb\.sql/.test(app))

console.log(`rain_mtb_test: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
