// job_drawer_test.mjs — the job card drawer (#510, 2026-09-27).
//
// Thijs approved CL Dashboard/mockups/maintenance-job-card.html: one drawer
// with Details · Materials · Cost · Complete replaces the view pop-up and the
// Edit / Complete pop-ups that stacked on it. These checks pin that shape and
// the behaviours that moved: details editable in place (admin, open job),
// the planned material list saved with the details, completion embedded with
// the drawer footer driving its save.
//
//   node tools/job_drawer_test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '@babel/parser'

const here = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(here, '..', 'src', 'App.jsx'), 'utf8')

const THEME = readFileSync(join(here, '..', 'src', 'theme.js'), 'utf8')

let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}
const fn = (name) => { const i = APP.indexOf(`function ${name}(`); const j = APP.indexOf('\nfunction ', i + 10); return APP.slice(i, j < 0 ? undefined : j) }

parse(APP, { sourceType: 'module', plugins: ['jsx'] })
check('App.jsx parses', true)
for (const cls of ['.drawer-scrim', '.drawer{', '.drawer-tabs', '.drawer-body', '.drawer-foot', '.drawer-sect', '.drawer-note', '.field.full'])
  check(`theme has ${cls}`, THEME.includes(cls))

check('Drawer component exists and closes on Escape', /function Drawer\(/.test(APP) && /e\.key === "Escape"/.test(fn('Drawer')))
check('EditJob pop-up is gone (hoisted into the drawer)', !/function EditJob\(/.test(APP))

const jd = fn('JobDetail')
check('JobDetail renders the Drawer', /<Drawer title=\{job\.name\}/.test(jd))
check('tabs: Details · Materials · Cost · Complete (Complete only while open)', /\{id:"details"/.test(jd) && /\{id:"materials"/.test(jd) && /\{id:"cost"/.test(jd) && /isOpen \? \[\{id:"complete"/.test(jd))
check('details are editable only for admin on an open job', /const canEdit = isOpen && isAdmin;/.test(jd) && /canEdit \? \(/.test(jd))
check('save writes the job patch and replaces the material list', /sb\.update\("maint_jobs", job\.id, patch\)/.test(jd) && /for\(const m of mats\) await sb\.delete\("maint_job_materials", m\.id\)/.test(jd))
check('dest_name is kept in step with destination_id', /dest_name:dest\?\.name\|\|null/.test(jd))
check('materials tab shows stock status and, for editors, the picker', /availableStock\(item, purchases, issues\)/.test(jd) && /<MaterialPicker items=\{items\} rows=\{rows\} setRows=\{setRows\}\/>/.test(jd))
check('cost tab keeps the invoice-disagreement warning', /invoiceTotalDisagrees\(cost\)/.test(jd))
check('completion is embedded and driven from the footer', /<CompleteJob embedded actionsRef=\{completeRef\} onBusyChange=\{setCompleteBusy\}/.test(jd) && /completeRef\.current\?\.save\(\)/.test(jd))
check('cancel / delete still confirm', /window\.confirm\("Cancel this job\?"\)/.test(jd) && /window\.confirm\("Delete this job permanently\?"\)/.test(jd))
check('save button is disabled until something changed', /onClick=\{saveDetails\} disabled=\{busy\|\|!dirty\}/.test(jd))

const cj = fn('CompleteJob')
check('CompleteJob accepts embedded/actionsRef/onBusyChange', /embedded = false, actionsRef = null, onBusyChange = null/.test(cj))
check('CompleteJob exposes save through the ref and mirrors busy', /actionsRef\.current = \{ save \}/.test(cj) && /onBusyChange\(busy\)/.test(cj))
check('CompleteJob returns bare content when embedded', /if \(embedded\) return content;/.test(cj))
check('CompleteJob still requires labour rows before completing', /Tick at least one employee/.test(cj))
check('CompleteJob still schedules the next occurrence', /nextDueOnCompletion\(tpl, tplJobs, date\)/.test(cj))

// Hooks in CompleteJob must not sit after an early return.
const retIdx = cj.indexOf('if (embedded) return content;')
const lastHook = Math.max(cj.lastIndexOf('useState('), cj.lastIndexOf('useEffect('), cj.lastIndexOf('useMemo('))
check('no hook after the embedded early return', lastHook < retIdx)

// Round 4 (2026-09-27): ad-hoc job and job templates on the same pattern.
const ah = fn('AdHocJob')
check('ad-hoc job is a ONE-screen drawer (no tabs)', /<Drawer title="Log a job"/.test(ah) && !/tabs=\{/.test(ah))
check('ad-hoc job keeps the material picker and saves job + materials', /<MaterialPicker items=\{items\} rows=\{rows\} setRows=\{setRows\}\/>/.test(ah) && /sb\.insert\("maint_jobs", job\)/.test(ah) && /sb\.insert\("maint_job_materials", m\)/.test(ah))
const jt = fn('JobTemplates')
check('job template form is a drawer with Job · Schedule · Materials', /\{id:"job",label:"Job"\},\{id:"schedule",label:"Schedule"\},\{id:"materials",label:"Materials"/.test(jt))
check('template rows open the drawer', /className="row-open" onClick=\{\(\)=>openEdit\(t\)\}/.test(jt))
check('the generation preview (#456) survives on the Schedule tab', /describeGeneration\(/.test(jt) && /Saving will create/.test(jt))
check('delete moved into the drawer footer', />Delete<\/button>/.test(jt) && !/btn-danger btn-sm" onClick=\{\(\)=>remove\(t\)\}>x/.test(jt))

// The drawer grows to fit its content instead of scrolling sideways (2026-09-28).
{
  const drawerSrc = APP
  const fit = drawerSrc.slice(drawerSrc.indexOf('function Drawer('), drawerSrc.indexOf('function Drawer(') + 4000)
  const okFit = /const overflow = el\.scrollWidth - el\.clientWidth/.test(fit) && /setFitWidth\(/.test(fit) && /window\.innerWidth - 250/.test(fit) && /new ResizeObserver\(measure\)/.test(fit) && /style=\{fitWidth \? \{ width: fitWidth \} : undefined\}/.test(fit) && /className="drawer-body" ref=\{bodyRef\}/.test(fit)
  const okMobile = /window\.innerWidth <= 768\) return/.test(fit)
  check('drawer widens itself when its content would scroll sideways (capped at screen minus sidebar)', okFit)
  check('drawer never grows past a phone or tablet screen', okMobile)
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall job drawer checks pass')
process.exit(failed ? 1 : 0)
