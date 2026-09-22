// Do the engines actually drive App.jsx? (#455, #456)
//
//   node tools/maintenance_wiring_test.mjs
//
// The arithmetic is tested next door. This checks the wiring, and the
// failures it exists for are the ones where the engine is right and the app
// ignores it:
//
//   - the job card computes a cost but renders the invoice total instead,
//     so the vehicle silently vanishes again;
//   - completion still creates the next card unconditionally, so a generated
//     schedule grows a duplicate on every single completion;
//   - the end date is collected in the form and never saved.
//
// App.jsx is a single 5,200-line component file, so these are asserted
// against the parsed program rather than by grepping — a name appearing
// somewhere in that much text means nothing.

import { parse } from '@babel/parser'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(here, '..', 'src', 'App.jsx'), 'utf8')

let passed = 0
const failures = []
const check = (name, cond, detail) =>
  cond ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
const eq = (name, actual, expected) =>
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)

let ast
try {
  ast = parse(APP, { sourceType: 'module', plugins: ['jsx'] })
  passed++
} catch (e) {
  console.log(`\n0 passed, 1 failed\n  FAIL: App.jsx does not parse — ${e.message}`)
  process.exit(1)
}

const walk = (node, fn) => {
  if (!node || typeof node !== 'object') return
  fn(node)
  for (const k of Object.keys(node)) {
    const v = node[k]
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn))
    else if (v && typeof v === 'object' && v.type) walk(v, fn)
  }
}

const callsTo = (name) => {
  const found = []
  walk(ast.program, (n) => {
    if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === name) {
      found.push(n)
    }
  })
  return found
}

// ---------------------------------------------------------------------------
// 1. THE ENGINES ARE IMPORTED, and from the right place.
{
  const imported = new Set()
  walk(ast.program, (n) => {
    if (n.type === 'ImportDeclaration' && /\.\/(jobCosting|recurrence)\.js$/.test(n.source.value)) {
      n.specifiers.forEach((s) => imported.add(s.local.name))
    }
  })
  for (const fn of [
    'jobCostBreakdown',
    'invoiceTotalDisagrees',
    'missingOccurrences',
    'nextDueOnCompletion',
    'nextDueFromOpenJobs',
    'describeGeneration',
  ]) {
    check(`${fn} is imported from its engine`, imported.has(fn))
  }
}

// ---------------------------------------------------------------------------
// 2. #455 — THE JOB CARD USES THE BREAKDOWN, not the invoice total.
{
  const calls = callsTo('jobCostBreakdown')
  eq('the breakdown is computed exactly once', calls.length, 1)

  if (calls.length) {
    const src = APP.slice(calls[0].start, calls[0].end)
    check('it is given the invoice for THIS job', /i\.job_id\s*===\s*job\.id/.test(src))
    check('and the trips for THIS job', /t\.job_id\s*===\s*job\.id/.test(src))
    check(
      'trips are filtered, not just found',
      /vehicleTrips\s*\|\|\s*\[\]\)\.filter/.test(src),
      '.find would take one trip and drop the rest of a multi-day job',
    )
  }

  // THE ONE THAT MATTERS. The rendered total must be cost.total — the figure
  // that includes the vehicle — and not cost.invoiceTotal, which never has.
  check(
    'the card renders the total that includes the vehicle',
    /\{fmtR\(cost\.total\)\}/.test(APP),
  )
  check(
    'the vehicle line is rendered',
    /cost\.vehicle/.test(APP) && /cost\.vehicleKm/.test(APP),
  )
  check(
    'an open job with a trip still shows its cost',
    /cost\.completed \|\| cost\.vehicle > 0/.test(APP),
    'gating on completion alone would hide money already spent on an open job',
  )
  check('the disagreement warning is rendered', /invoiceTotalDisagrees\(cost\)/.test(APP))

  // The data has to reach JobDetail: App -> Calendar -> JobDetail. Miss one
  // hop and the card always reads R0.00 with nothing on screen to explain it.
  //
  // Asserted PER ELEMENT rather than by counting occurrences. Counting said
  // "expected 2, got 3" because InternalBillingPage also takes vehicleTrips,
  // perfectly legitimately — a count over a 5,200-line file measures the
  // whole file, not the two renders in question.
  const attrsOn = (tag) => {
    const sets = []
    walk(ast.program, (n) => {
      if (n.type === 'JSXOpeningElement' && n.name?.type === 'JSXIdentifier' && n.name.name === tag) {
        sets.push(new Set(n.attributes.filter((a) => a.name).map((a) => a.name.name)))
      }
    })
    return sets
  }

  for (const tag of ['Calendar', 'JobDetail']) {
    const renders = attrsOn(tag)
    eq(`<${tag}> is rendered exactly once`, renders.length, 1)
    if (renders.length) {
      check(`<${tag}> receives jobInvoices`, renders[0].has('jobInvoices'))
      check(`<${tag}> receives vehicleTrips`, renders[0].has('vehicleTrips'))
    }
  }

  // …and both components actually accept them, rather than silently dropping
  // props the parent bothered to pass.
  for (const fn of ['Calendar', 'JobDetail']) {
    let params = null
    walk(ast.program, (n) => {
      if (n.type === 'FunctionDeclaration' && n.id?.name === fn && n.params[0]?.type === 'ObjectPattern') {
        params = new Set(n.params[0].properties.filter((p) => p.key).map((p) => p.key.name))
      }
    })
    check(`${fn} destructures jobInvoices`, !!params && params.has('jobInvoices'))
    check(`${fn} destructures vehicleTrips`, !!params && params.has('vehicleTrips'))
  }
}

// ---------------------------------------------------------------------------
// 3. #456 — COMPLETION GOES THROUGH THE GUARD.
{
  const calls = callsTo('nextDueOnCompletion')
  eq('completion asks the engine what to schedule', calls.length, 1)

  // The old code computed the next date inline with addPeriod and inserted
  // unconditionally. If that shape survives anywhere near the completion
  // path, a generated schedule grows a duplicate on every completion.
  check(
    'the old unconditional next-job calculation is gone',
    !/const nextDue = fmtDMY\(addPeriod\(parseDMY\(date\)/.test(APP),
    'this is the line that created a card whether or not one already existed',
  )
  check(
    'and the insert is conditional on the engine returning a date',
    /if\(tpl && nextDue\)\{/.test(APP),
  )
  check(
    'the engine is given the template’s other jobs, excluding this one',
    /jobs\.filter\(j=>j\.template_id===job\.template_id && j\.id!==job\.id\)/.test(APP),
    'passing this job in would let it block its own successor',
  )
  check(
    'jobs reaches CompleteJob at all',
    /function CompleteJob\(\{[^}]*\bjobs\b/.test(APP) && /<CompleteJob[\s\S]{0,400}?jobs=\{jobs\}/.test(APP),
  )

  // next_due must follow the open cards in BOTH branches — the one that
  // creates a card and the one that does not.
  eq('next_due follows the open cards, both branches', callsTo('nextDueFromOpenJobs').length, 2)
}

// ---------------------------------------------------------------------------
// 4. #456 — THE END DATE IS COLLECTED, SAVED AND ACTED ON.
{
  check('there is a field for it', /Repeat Until/.test(APP))
  check('the blank form has it', /recurrence_end_date:""\}/.test(APP))
  check('editing an existing template loads it', /recurrence_end_date:t\.recurrence_end_date/.test(APP))
  check(
    'saving persists it',
    /recurrence_end_date: form\.recurrence_type==="none" \? null : \(form\.recurrence_end_date\.trim\(\)\|\|null\)/.test(APP),
    'collected in the form and never written is the classic half-built feature',
  )

  const gen = callsTo('missingOccurrences')
  eq('save asks which occurrences are missing', gen.length, 1)

  // THE MIGRATION PROMISE, in the app rather than the engine: with no end
  // date, a new template makes exactly one card and an edit makes none —
  // precisely what the code did before.
  check(
    'no end date falls back to the old one-card behaviour',
    /: \(editId \? \[\] : \[row\.next_due\]\)/.test(APP),
    'without this, editing any existing template would start generating',
  )
  check(
    'the count is shown before anything is written',
    /describeGeneration\(/.test(APP) && /Saving will create/.test(APP),
    '"47 cards" is worth knowing in advance, not discovering in the calendar',
  )
  check('and the cap is explained when hit', /Capped at \{preview\.cappedAt\}/.test(APP))
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  failures.forEach((f) => console.log(`  FAIL: ${f}`))
  process.exit(1)
}
