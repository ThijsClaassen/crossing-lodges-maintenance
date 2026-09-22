// What a job card cost, vehicle included (#455).
//
//   node tools/job_costing_test.mjs
//
// The failure this guards against is a number that looks right and is not:
// a job total that quietly omits the vehicle. That is the whole reason the
// figure was asked for — a call-out where the bakkie did 180km is not a
// two-hour job, and a total that says it is will be believed.

import { jobCostBreakdown, invoiceTotalDisagrees } from '../src/jobCosting.js'

let passed = 0
const failures = []
const check = (name, cond, detail) =>
  cond ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
const eq = (name, actual, expected) =>
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)

// ---------------------------------------------------------------------------
// 1. THE WHOLE POINT — the vehicle is in the total.
{
  const b = jobCostBreakdown({
    invoice: { labor_cost: 450, material_cost: 320.5, total_cost: 770.5 },
    trips: [{ trip_cost: 180.25, km: 45 }],
  })
  eq('labour', b.labour, 450)
  eq('materials', b.materials, 320.5)
  eq('vehicle', b.vehicle, 180.25)
  eq('km', b.vehicleKm, 45)
  eq('THE TOTAL INCLUDES THE VEHICLE', b.total, 950.75)
  check(
    'and it is not the invoice total',
    b.total !== b.invoiceTotal,
    'maint_job_invoices.total_cost has never included the vehicle — if these matched, nothing was added',
  )
  eq('the invoice total is carried through unchanged', b.invoiceTotal, 770.5)
  eq('one trip', b.tripCount, 1)
}

// ---------------------------------------------------------------------------
// 2. SEVERAL TRIPS on one job, which is the normal case for a multi-day job.
{
  const b = jobCostBreakdown({
    invoice: { labor_cost: 100, material_cost: 0, total_cost: 100 },
    trips: [
      { trip_cost: 50, km: 12 },
      { trip_cost: 75.5, km: 18.5 },
      { trip_cost: 24.5, km: 6 },
    ],
  })
  eq('trips are summed', b.vehicle, 150)
  eq('km are summed', b.vehicleKm, 36.5)
  eq('three trips', b.tripCount, 3)
  eq('total', b.total, 250)
}

// ---------------------------------------------------------------------------
// 3. NO VEHICLE — the common case, and it must not become NaN or R0 noise.
{
  const b = jobCostBreakdown({
    invoice: { labor_cost: 200, material_cost: 55, total_cost: 255 },
    trips: [],
  })
  eq('no vehicle cost', b.vehicle, 0)
  eq('no km', b.vehicleKm, 0)
  eq('total is labour plus materials', b.total, 255)
  check('and it agrees with the invoice', !invoiceTotalDisagrees(b))
}

// ---------------------------------------------------------------------------
// 4. AN OPEN JOB WITH A TRIP ALREADY LOGGED.
//
// Real: somebody drives out, logs the trip, and the job stays open for a
// week. There is a genuine cost with no invoice behind it. Reporting R0
// would be wrong; reporting nothing would hide money already spent.
{
  const b = jobCostBreakdown({ invoice: null, trips: [{ trip_cost: 90, km: 22 }] })
  eq('no labour yet', b.labour, 0)
  eq('no materials yet', b.materials, 0)
  eq('but the vehicle cost is real', b.vehicle, 90)
  eq('and it shows in the total', b.total, 90)
  eq('flagged as not yet completed', b.completed, false)
  check('and that flag is what the card uses to caveat the figure', b.completed === false)
}

// ---------------------------------------------------------------------------
// 5. RUBBISH IN — a missing or malformed figure must read as zero, never NaN.
// A NaN renders as "R NaN" on the card and looks like a crash.
{
  const b = jobCostBreakdown({
    invoice: { labor_cost: null, material_cost: undefined, total_cost: 'x' },
    trips: [{ trip_cost: null, km: undefined }, { trip_cost: 'abc', km: {} }],
  })
  eq('null labour is zero', b.labour, 0)
  eq('undefined materials is zero', b.materials, 0)
  eq('unparseable trip cost is zero', b.vehicle, 0)
  eq('unparseable km is zero', b.vehicleKm, 0)
  eq('total is zero, not NaN', b.total, 0)
  check('nothing is NaN', Object.values(b).every((v) => typeof v !== 'number' || Number.isFinite(v)))

  const empty = jobCostBreakdown()
  eq('called with nothing at all', empty.total, 0)
  eq('and it is not completed', empty.completed, false)
}

// ---------------------------------------------------------------------------
// 6. FLOAT DRIFT. Three trips of 0.1 must not total 0.30000000000000004.
{
  const b = jobCostBreakdown({
    invoice: { labor_cost: 0.1, material_cost: 0.2, total_cost: 0.3 },
    trips: [{ trip_cost: 0.1, km: 0 }, { trip_cost: 0.2, km: 0 }],
  })
  eq('vehicle is rounded', b.vehicle, 0.3)
  eq('total is rounded', b.total, 0.6)
}

// ---------------------------------------------------------------------------
// 7. THE DISAGREEMENT CHECK.
//
// generateJobInvoice writes labour, materials and total together, so they
// always agree. If they ever do not, the row came from somewhere else or was
// edited by hand — and silently adding the vehicle on top of an already-wrong
// total would bury that rather than show it.
{
  const fine = jobCostBreakdown({
    invoice: { labor_cost: 100, material_cost: 50, total_cost: 150 },
    trips: [],
  })
  check('a consistent invoice does not complain', !invoiceTotalDisagrees(fine))

  const off = jobCostBreakdown({
    invoice: { labor_cost: 100, material_cost: 50, total_cost: 900 },
    trips: [],
  })
  check('an inconsistent one does', invoiceTotalDisagrees(off))

  const rounding = jobCostBreakdown({
    invoice: { labor_cost: 33.33, material_cost: 66.66, total_cost: 99.99 },
    trips: [],
  })
  check('a cent of rounding is not a disagreement', !invoiceTotalDisagrees(rounding))

  check(
    'an open job cannot disagree, having no invoice to disagree with',
    !invoiceTotalDisagrees(jobCostBreakdown({ invoice: null, trips: [{ trip_cost: 10 }] })),
  )
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  failures.forEach((f) => console.log(`  FAIL: ${f}`))
  process.exit(1)
}
