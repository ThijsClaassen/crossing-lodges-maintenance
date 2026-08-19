// Cross-app read: "how many Maintenance-department staff are on duty at
// this lodge today?" (2026-08-19), for the Projects AI Suggestions panel.
//
// hr_employees / hr_schedule_locations / hr_leave live in HR/Linen's part
// of this same shared Supabase project (arrendpmuwdhrfwvokhv) — same
// pattern already used by crossing-lodges-budget's staffCostReportEngine.js
// and staffingCoverageEngine.js to read HR data cross-app. RLS on those
// tables is has_company_access(company_id), not app-scoped, so Maintenance's
// own logged-in session can read them as long as the user belongs to the
// company — nothing new to grant.
//
// The on/off-cycle and "which lodge this week" logic below is a deliberate
// duplicate of crossing-lodges-HR-Linen/src/App.jsx's cycleStatusForDate /
// dayInfo / actualCountFor, kept in lock-step with that source of truth
// rather than imported (separate deploys, no shared package). If HR/Linen's
// rotation logic ever changes, this needs updating too.

const CYCLE_ON_DAYS = 21
const CYCLE_OFF_DAYS = 7
const CYCLE_LENGTH = CYCLE_ON_DAYS + CYCLE_OFF_DAYS // 28

function parseDateOnly(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

// Monday-anchored week start, matching hr_schedule_locations.week_start_date
// (always Monday-anchored regardless of any display setting, per HR/Linen).
function mondayOf(date) {
  const day = date.getDay()
  const diff = (day - 1 + 7) % 7
  const d = addDays(date, -diff)
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function cycleStatusForDate(cycleAnchorDate, date) {
  if (!cycleAnchorDate) return { status: 'none' }
  const anchor = parseDateOnly(cycleAnchorDate)
  const diffDays = Math.round((date - anchor) / 86400000)
  let phase = diffDays % CYCLE_LENGTH
  if (phase < 0) phase += CYCLE_LENGTH
  return { status: phase < CYCLE_ON_DAYS ? 'on' : 'off' }
}

function leaveOnDate(leaveRows, employeeId, date) {
  const ds = (() => {
    const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  })()
  return (leaveRows || []).some((l) => l.employee_id === employeeId && l.start_date <= ds && l.end_date >= ds)
}

// Same trim/collapse-whitespace/title-case normalizer as Finance
// Dashboard's staffCostReportEngine.js, so "Maintenance", "maintenance ",
// "MAINTENANCE" etc. all match regardless of how it was typed into HR/Linen.
export function normalizeDepartment(raw) {
  const trimmed = (raw || '').trim().replace(/\s+/g, ' ')
  if (!trimmed) return 'Unassigned'
  return trimmed
    .toLowerCase()
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

// employees/scheduleLocations/leave: raw rows from hr_employees /
// hr_schedule_locations / hr_leave (company-scoped fetch already applied
// by the caller). locationId: 'ZC'|'EC'|'SC'. date: a JS Date.
//
// Mirrors HR/Linen's own actualCountFor exactly: only counts an employee
// if they have an explicit hr_schedule_locations row for that week
// assigning them to this lodge — no row means "unknown for this week", not
// "available everywhere", same as the Staffing Coverage tab already does.
// Employees with no cycle_anchor_date at all (status 'none' — not on the
// 21/7 rotation) are excluded too, again matching that existing behaviour.
export function availableMaintenanceStaff({ employees, scheduleLocations, leave, locationId, date }) {
  const weekKey = mondayOf(date)
  const locByEmployee = {}
  for (const s of scheduleLocations || []) {
    if (s.week_start_date === weekKey) locByEmployee[s.employee_id] = s.location_id
  }
  const onDuty = (employees || []).filter((e) => {
    if (!e.active) return false
    if (normalizeDepartment(e.department) !== 'Maintenance') return false
    if (leaveOnDate(leave, e.id, date)) return false
    if (cycleStatusForDate(e.cycle_anchor_date, date).status !== 'on') return false
    return locByEmployee[e.id] === locationId
  })
  return {
    count: onDuty.length,
    names: onDuty.map((e) => `${e.first_name} ${e.last_name}`.trim()),
  }
}
