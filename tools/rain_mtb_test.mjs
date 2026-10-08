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

// ── Rainfall: meters ───────────────────────────────────────────────────────
// Thijs: "I want to be able to add different rain meters. We have 3 meters on
// 1 farm." A lodge's rain is the AVERAGE of the meters read in the period.
const rain = [
  // ZC has three meters: A, B, C.
  { location_id: 'ZC', gauge_id: 'A', reading_date: '2026-10-01', mm: 10 },
  { location_id: 'ZC', gauge_id: 'B', reading_date: '2026-10-01', mm: 12 },
  { location_id: 'ZC', gauge_id: 'C', reading_date: '2026-10-01', mm: 8 },
  { location_id: 'ZC', gauge_id: 'A', reading_date: '2026-10-03', mm: 5 },     // only A read on the 3rd
  { location_id: 'ZC', gauge_id: 'A', reading_date: '2026-07-03', mm: 2 },     // this season
  { location_id: 'ZC', gauge_id: 'A', reading_date: '2026-01-20', mm: 30 },
  { location_id: 'ZC', gauge_id: 'A', reading_date: '2025-10-02', mm: 10 },    // last year, same span
  { location_id: 'ZC', gauge_id: 'A', reading_date: '2025-07-15', mm: 4 },     // last season
  { location_id: 'ZC', gauge_id: 'C', reading_date: '2026-10-04', mm: 0 },     // dry check
  { location_id: 'EC', gauge_id: 'E', reading_date: '2026-10-02', mm: 20 },
  { location_id: 'EC', gauge_id: null, reading_date: '2026-09-01', mm: 6 },     // from before meters
]
const oct = R.lodgeRain(rain, 'ZC', '2026-10-01', '2026-10-31')
check('three meters: lodge rain is their average, not the sum ((15 + 12 + 8) / 3)', oct.mm === 11.7 && oct.meters === 3, JSON.stringify(oct))
check('one meter on its own', R.gaugeRain(rain, 'A', '2026-10-01', '2026-10-31') === 15 && R.gaugeRain(rain, 'C', '2026-10-01', '2026-10-31') === 8)
check('only meters read in the span count (January: just A)', R.lodgeRain(rain, 'ZC', '2026-01-01', '2026-01-31').mm === 30)
check('readings from before meters count as one meter for their lodge', R.lodgeRain(rain, 'EC', '2026-09-01', '2026-09-30').mm === 6 && R.gaugeKey({ location_id: 'EC', gauge_id: null }) === 'lodge:EC')

const yr = R.lodgeYear(rain, 'ZC', 2026, ['A', 'B', 'C'])
check('year grid: each meter gets its own column', yr.gauges.A[9] === 15 && yr.gauges.B[9] === 12 && yr.gauges.C[9] === 8)
check('year grid: the lodge column is the average, with how many meters were read', yr.lodge[9] === 11.7 && yr.meters[9] === 3 && yr.lodge[0] === 30 && yr.meters[0] === 1)

const s = R.rainSummary(rain, { today: '2026-10-04', locId: 'ZC' })
check('this month at ZC: the meters\' average', s.month === 11.7)
check('year to date: average of each meter\'s year total ((30+2+15) + 12 + 8) / 3', s.yearToDate === 22.3, String(s.yearToDate))
check('same span last year: 4 + 10 (one meter then)', s.yearToDateLastYear === 14)
check('rain season starts 1 July', s.seasonLabel === '2026/27' && s.season === Math.round(((2 + 15) + 12 + 8) / 3 * 10) / 10)
check('last season to the same day: 4 + 10', s.seasonLastYear === 14)
check('last rain ignores a 0 mm check', s.lastRain === '2026-10-03')
check('in June the season is the one that started last July', R.rainSummary(rain, { today: '2026-06-30', locId: 'ZC' }).seasonLabel === '2025/26')
check('29 Feb compares against 28 Feb last year without breaking', typeof R.rainSummary(rain, { today: '2028-02-29', locId: 'ZC' }).yearToDateLastYear === 'number')
check('one reading per METER per day: the same meter finds it, another meter does not', R.existingReading(rain, { gauge_id: 'A', location_id: 'ZC', reading_date: '2026-10-01' })?.mm === 10 && R.existingReading(rain, { gauge_id: 'B', location_id: 'ZC', reading_date: '2026-10-03' }) === null)
check('…and a reading from before meters is found by lodge and day', R.existingReading(rain, { gauge_id: null, location_id: 'EC', reading_date: '2026-09-01' })?.mm === 6)

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

// Job cards (Thijs: "Link MTB's to jobcard when work is being done on MTB's").
const jobs = [
  { id: 'j1', mtb_bike_id: 'b10', mtb_issue_id: 'x', status: 'completed' },   // fixed a problem: its cost is on the problem
  { id: 'j2', mtb_bike_id: 'b10', status: 'completed' },                       // planned service: cost added on top
  { id: 'j3', mtb_bike_id: 'b5', status: 'scheduled' },
]
const withJobs = R.bikeSummary(bikes[0], [...issues, { bike_id: 'b10', job_id: 'j1', reported_on: '2026-09-25', problem: 'chain', status: 'fixed', cost: 300 }], { jobs, jobCosts: { j1: 300, j2: 450 } })
check('spend counts a problem\'s job cost once (on the problem) and adds job cards not tied to a problem', withJobs.spend === 150 + 300 + 450, String(withJobs.spend))
check('job cards per bike counted', withJobs.jobs === 2)
const job = R.jobFromProblem({ id: 'b10', code: 'MTB 10', location_id: 'ZC', make_model: 'Trek' }, { id: 'i9', problem: 'rear brake soft', reported_on: '2026-10-04', reported_by: 'Guide Sam' }, { id: 'J', companyId: 'C', dueDMY: '04/10/2026' })
check('a problem becomes a job card: on today\'s calendar, at the bike\'s lodge, named for the bike, linked both ways', job.name === 'MTB 10: rear brake soft' && job.due_date === '04/10/2026' && job.status === 'scheduled' && job.location_id === 'ZC' && job.mtb_bike_id === 'b10' && job.mtb_issue_id === 'i9' && /Guide Sam/.test(job.description))

// ── SQL and wiring ─────────────────────────────────────────────────────────
const sql = readFileSync(join(ROOT, 'add_rainfall_and_mtb.sql'), 'utf8')
const body = sql.slice(0, sql.indexOf('THE MIGRATION ENDS HERE'))
check('SQL: rain meters table; a reading belongs to a meter; one reading per meter per day', /create table if not exists maint_rain_gauges/.test(body) && /alter table maint_rainfall add column if not exists gauge_id uuid references maint_rain_gauges\(id\)/.test(body) && /drop constraint if exists maint_rainfall_company_id_location_id_reading_date_key/.test(body) && /on maint_rainfall \(company_id, coalesce\(gauge_id::text, 'lodge:' \|\| location_id\), reading_date\)/.test(body))
check('SQL: job cards link to a bike and its problem, and the problem to its job (all set null on delete)', /alter table mtb_issues add column if not exists job_id uuid references maint_jobs\(id\) on delete set null/.test(body) && /alter table maint_jobs add column if not exists mtb_bike_id uuid references mtb_bikes\(id\) on delete set null/.test(body) && /alter table maint_jobs add column if not exists mtb_issue_id uuid references mtb_issues\(id\) on delete set null/.test(body) && /references mtb_bikes\(id\) on delete cascade/.test(body))
check('SQL: every new table has created_at and company RLS + grants', ['maint_rain_gauges', 'maint_rainfall', 'mtb_bikes', 'mtb_issues'].every((t) => new RegExp(`create policy "allow_company_${t}"`).test(body) && new RegExp(`grant select, insert, update, delete on ${t} to authenticated`).test(body)) && (body.match(/created_at timestamptz not null default now\(\)/g) || []).length === 4)
check('SQL: roles step 5 rule applied when present (Maintenance writes only)', /to_regprocedure\('can_write_app\(uuid, text\[\]\)'\) is null/.test(body) && /as restrictive for insert/.test(body))
check('SQL: marker present, nothing live after it', !/^\s*(create|alter|drop|grant|do)\b/m.test(sql.slice(sql.indexOf('THE MIGRATION ENDS HERE')).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')))

const app = readFileSync(join(ROOT, 'src', 'App.jsx'), 'utf8')
check('menu: MTB and Rainfall under "Assets", open to everyone', /\{id:"mtb",\s+label:"MTB",\s+section:"Assets",\s+adminOnly:false\}/.test(app) && /\{id:"rainfall",\s+label:"Rainfall",\s+section:"Assets",\s+adminOnly:false\}/.test(app))
check('pages routed (MTB gets the job cards and their costs)', /page==="mtb"\s+&& <MtbPage [^>]*jobs=\{jobs\} setJobs=\{setJobs\} jobInvoices=\{jobInvoices\}/.test(app) && /page==="rainfall"\s+&& <RainfallPage [^>]*isAdmin=\{isAdmin\}/.test(app))
check('rainfall: a second reading for the same meter and day replaces the first', /const existing = existingReading\(all, key\);[\s\S]{0,200}if \(existing\) \{\s*await sb\.update\("maint_rainfall"/.test(app))
check('rainfall: admins add, rename and stop meters; logging needs a meter', /isAdmin && <button className="btn btn-ghost" onClick=\{\(\) => setMeterForm/.test(app) && /sb\.insert\("maint_rain_gauges"/.test(app) && /disabled=\{!lodgeMeters\.length\}/.test(app))
check('MTB: "Create job card" on an open problem, linked both ways', /createJobFor = async issue =>[\s\S]{0,300}sb\.insert\("maint_jobs", job\)[\s\S]{0,100}sb\.update\("mtb_issues", issue\.id, \{ job_id: job\.id \}\)/.test(app))
check('MTB: completing the job card closes the problem with the job\'s cost', /if \(job\.mtb_issue_id\) \{[\s\S]{0,200}sb\.update\("mtb_issues", job\.mtb_issue_id, \{[\s\S]{0,200}cost: jobInvoice \? jobInvoice\.total_cost : null/.test(app) && /return invoice;/.test(app))
check('MTB: ad-hoc job cards can be tagged to a bike', /<label>Mountain bike<\/label>/.test(app) && /mtb_bike_id: bike\.id/.test(app))
check('MTB: adding / editing / retiring a bike is admin-only; logging and fixing problems is for everyone', /\{isAdmin && <button className="btn btn-primary" onClick=\{\(\) => setNewBike/.test(app) && /disabled=\{!isAdmin\}/.test(app) && /onClick=\{logProblem\}/.test(app) && !/isAdmin && <button[^>]*logProblem/.test(app))
check('both pages explain a missing table instead of failing', /run add_rainfall_and_mtb\.sql/.test(app))

// #562 (2026-10-08): planned bike work can be dated ahead, e.g. the next service.
check('Plan work has a due date (today by default) next to Create job card', /const \[workDate, setWorkDate\] = useState\(isoToday\)/.test(app) && /<input type="date" aria-label="Due on"[^>]*value=\{workDate\}/.test(app))
check('the job cards come from planBikeWork with the picked date (not always today)', /planBikeWork\(bike, what, \{ startISO: workDate, repeat, companyId, newId: uid \}\)/.test(app) && !/job_type: "preventive",\s*destination_id: null, dest_name: null, assigned_to: null, due_date: today\(\)/.test(app))
check('says where it goes before creating (the plan note, or "Goes on the Calendar on …")', /\{plan \? plan\.note/.test(app) && /Goes on the Calendar on \$\{fromISO\(workDate\)\}/.test(app))
check('form resets after creating (date back to today, repeat back to once)', /setNewWork\(""\); setWorkDate\(isoToday\); setRepeat\(\{ type: "none"/.test(app))

// #562 follow-up (2026-10-08): repeating bike work = a job template on the bike.
{
  const R = await import(pathToFileURL(join(ROOT, 'src', 'rainMtb.js')).href)
  let n = 0
  const newId = () => `id${++n}`
  const bike = { id: 'b7', code: 'MTB 07', location_id: 'ZC', make_model: 'Giant Talon' }
  const once = R.planBikeWork(bike, 'new tyres', { startISO: '2026-11-12', companyId: 'c1', newId })
  check('once: one job card, no template, due on the picked date (DD/MM/YYYY)', !once.template && once.jobs.length === 1 && once.jobs[0].due_date === '12/11/2026' && once.jobs[0].mtb_bike_id === 'b7' && once.jobs[0].template_id === null)
  check('once: named for the bike, preventive, scheduled', once.jobs[0].name === 'MTB 07: new tyres' && once.jobs[0].job_type === 'preventive' && once.jobs[0].status === 'scheduled')

  const open = R.planBikeWork(bike, 'full service', { startISO: '2026-11-12', repeat: { type: 'months', n: '3' }, companyId: 'c1', newId })
  check('repeat, no end: a template + ONE card now (next card on completion, like Job Templates)', open.template && open.jobs.length === 1 && open.template.recurrence_type === 'months' && open.template.recurrence_n === 3 && open.template.recurrence_end_date === null && open.template.next_due === '12/11/2026')
  check('repeat: the template and its card both carry the bike; the card points at the template', open.template.mtb_bike_id === 'b7' && open.jobs[0].mtb_bike_id === 'b7' && open.jobs[0].template_id === open.template.id && open.template.active === true)
  check('repeat, no end: the note explains the next card comes on completion', /then every 3 months: the next card is made when each one is completed/.test(open.note))

  const till = R.planBikeWork(bike, 'full service', { startISO: '2026-11-12', repeat: { type: 'months', n: 3, endISO: '2027-06-30' }, companyId: 'c1', newId })
  check('repeat with an end date: every card up to it (12/11, 12/02, 12/05)', till.jobs.map((j) => j.due_date).join() === '12/11/2026,12/02/2027,12/05/2027' && till.template.recurrence_end_date === '30/06/2027', till.jobs.map((j) => j.due_date).join())
  check('…and the note says how many', /^3 job cards, every 3 months from 12\/11\/2026 to 30\/06\/2027/.test(till.note))
  check('weekly works too, n defaults to 1', R.planBikeWork(bike, 'wash', { startISO: '2026-11-02', repeat: { type: 'weeks', n: '', endISO: '2026-11-16' }, companyId: 'c1', newId }).jobs.length === 3)
  check('everyText', R.everyText('months', 1) === 'every month' && R.everyText('weeks', 2) === 'every 2 weeks')

  check('drawer: Repeat (admins) with every N weeks/months and an optional end date', /isAdmin && \(<>\s*<span style=\{\{color:T\.muted\}\}>Repeat<\/span>/.test(app) && /aria-label="Until \(optional\)"/.test(app))
  check('drawer: writes the template first, then the cards; asks before making several', /if \(template\) \{ await sb\.insert\("maint_job_templates", template\)/.test(app) && /made\.length > 1 && !window\.confirm/.test(app))
  check('drawer: lists the bike\'s repeating work with Stop repeating (active=false, cards stay)', /Repeating · \{templates\.length\}/.test(app) && /sb\.update\("maint_job_templates", t\.id, \{ active: false \}\)/.test(app))
  check('completing a card of a bike template: the next card stays on the bike', /\.\.\.\(tpl\.mtb_bike_id \? \{ mtb_bike_id: tpl\.mtb_bike_id \} : \{\}\)/.test(app))
  check('editing a bike template under Job Templates: generated cards stay on the bike', /const tplBike = editId \? \(templates\.find\(t=>t\.id===editId\)\?\.mtb_bike_id \|\| null\) : null;/.test(app) && /\.\.\.\(tplBike \? \{ mtb_bike_id: tplBike \} : \{\}\)/.test(app))
  check('MtbPage gets the templates', /<MtbPage [^>]*templates=\{templates\} setTemplates=\{setTemplates\}\/>/.test(app))
  const sql = readFileSync(join(ROOT, 'add_mtb_recurring.sql'), 'utf8')
  check('SQL: maint_job_templates.mtb_bike_id, safe to re-run', /alter table maint_job_templates\s+add column if not exists mtb_bike_id uuid references mtb_bikes\(id\) on delete set null/.test(sql))
}

console.log(`rain_mtb_test: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
