// What a job card actually cost (#455, 2026-09-22).
//
// Thijs: "want to see per job card what the total cost for the job was,
// including the vehicle cost."
//
// Three components, from three different places, and the split matters:
//
//   labour     maint_job_invoices.labor_cost     snapshotted at completion,
//                                                because an employee's hourly
//                                                rate changes and the job
//                                                cost what it cost on the day.
//   materials  maint_job_invoices.material_cost  same reasoning.
//   vehicle    vehicle_trips, joined on job_id   read LIVE, deliberately.
//
// The vehicle figure is the odd one out and it is not an oversight. A trip is
// very often logged after the job is closed, so a figure frozen at completion
// would silently miss it and the job would under-report forever. The cost is
// already frozen per trip (Ops snapshots cost_per_km onto the trip row), so
// reading live cannot restate history either — it can only pick up trips that
// had not been captured yet. Internal Billing has read it this way since
// 2026-08-27; this puts the same number on the job card.
//
// Pure. Tested in tools/job_costing_test.mjs.

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

// { invoice, trips } -> the breakdown shown on a job card.
//
// `invoice` is the maint_job_invoices row for this job, or null when the job
// has not been completed yet. `trips` is every vehicle_trips row carrying
// this job_id.
export function jobCostBreakdown({ invoice, trips = [] } = {}) {
  const labour = round2(invoice?.labor_cost)
  const materials = round2(invoice?.material_cost)

  const vehicle = round2(trips.reduce((s, t) => s + (Number(t.trip_cost) || 0), 0))
  const vehicleKm = round2(trips.reduce((s, t) => s + (Number(t.km) || 0), 0))

  return {
    labour,
    materials,
    vehicle,
    vehicleKm,
    tripCount: trips.length,
    total: round2(labour + materials + vehicle),

    // Whether there is a completion figure at all. An open job with a trip
    // logged against it has a real vehicle cost and no labour or materials
    // yet — showing that as "R0.00 total" would be wrong, and showing
    // nothing would hide a cost that has already been incurred.
    completed: !!invoice,

    // The invoice total does NOT include the vehicle — it never has. Carried
    // through so the card can say where the difference comes from rather than
    // leaving two totals on screen that disagree.
    invoiceTotal: round2(invoice?.total_cost),
  }
}

// Does the stored invoice total agree with labour + materials?
//
// It always should — generateJobInvoice writes all three together. If it ever
// does not, the invoice was written by something else or edited by hand, and
// quietly adding the vehicle cost on top of a total that is already wrong
// would bury the problem rather than show it.
export function invoiceTotalDisagrees(breakdown) {
  if (!breakdown?.completed) return false
  return Math.abs(breakdown.invoiceTotal - round2(breakdown.labour + breakdown.materials)) > 0.01
}
