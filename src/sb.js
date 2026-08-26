// Lightweight Supabase REST wrapper — same pattern as crossing-lodges-food,
// crossing-lodges-HR-Linen, and crossing-lodges-ops (small bundle, no SDK
// version dependency, plain fetch calls against PostgREST). Extracted out
// of App.jsx during the multi-tenant rebuild (2026-08-08), same reason as
// Ops's: keeps Login.jsx/SetPassword.jsx/CompanyContext.jsx from needing a
// circular import back into App.jsx.
//
// Points at the SAME Supabase project as Finance Dashboard/Food Stock/
// HR-Linen/Ops so they all share one database.
//
// Note this app's select() takes a raw PostgREST filter STRING (e.g.
// "role=eq.admin"), not a filters object — same convention as Ops's sb.js,
// kept as-is rather than changed to avoid rewriting every call site.
//
// Made session-aware 2026-08-08 (Maintenance 3b of the multi-tenant
// rebuild): headers() now reads the real Supabase Auth session and sends
// the user's own access token instead of only the anon key, so RLS's
// auth.uid() resolves to the logged-in user rather than nobody. Every call
// site was grepped and updated to `await headers()` from the start — see
// [[feedback-git-and-async-gotchas]] for why that matters.

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseClient.js'

const SB_URL = SUPABASE_URL

async function headers(extra = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...extra,
  }
}

export const sb = {
  async select(t, f = '') {
    const r = await fetch(`${SB_URL}/rest/v1/${t}?${f}&order=created_at.asc`, { headers: await headers() })
    if (!r.ok) throw new Error(await r.text())
    return r.json()
  },
  async insert(t, row) {
    const r = await fetch(`${SB_URL}/rest/v1/${t}`, {
      method: 'POST',
      headers: await headers(),
      body: JSON.stringify(row),
    })
    if (!r.ok) throw new Error(await r.text())
    const d = await r.json()
    return Array.isArray(d) ? d[0] : d
  },
  async update(t, id, patch) {
    const r = await fetch(`${SB_URL}/rest/v1/${t}?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify(patch),
    })
    if (!r.ok) throw new Error(await r.text())
  },
  async delete(t, id) {
    const r = await fetch(`${SB_URL}/rest/v1/${t}?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: await headers(),
    })
    if (!r.ok) throw new Error(await r.text())
  },
}

// Lodges for the current company. Loaded from the shared `locations` table
// at login (see CompanyContext.jsx) instead of being hardcoded, so a second
// company's own lodges work without a code change (2026-08-26).
//
// Deliberately a MUTABLE module array rather than React state: this app
// already reads LOCATIONS synchronously in a number of places, some outside
// components, and converting every one to a hook would be a large change for
// no visible benefit today. CompanyContext fills this in BEFORE it renders
// any children, and refills it on company switch, so by the time anything
// reads it, it's correct. The array identity never changes — contents are
// replaced in place — so existing dependency arrays keep behaving as before.
export const LOCATIONS = []

// Only 'lodge' rows: the shared locations table also holds an 'overhead'
// (head office) row that the Finance Dashboard uses for non-lodge costs and
// that this app has never shown. Ordering is by created_at, not id, because
// the established display order is ZC, EC, SC — which alphabetical order
// would reshuffle to EC, SC, ZC.
export function setLocations(rows) {
  LOCATIONS.length = 0
  for (const r of rows || []) {
    if (r.type && r.type !== 'lodge') continue
    LOCATIONS.push({ id: r.id, name: r.name, type: r.type ?? null })
  }
  refreshLocColors()
}

// Per-lodge accent colours. Previously a hardcoded { ZC: ..., EC: ..., SC: ... }
// map; now assigned by position from a fixed palette so any lodge list works.
// The first three palette entries are the exact colours ZC/EC/SC have always
// had, and setLocations preserves their order, so nothing changes visually.
const LOC_PALETTE = ['#B8935A', '#5B8CC4', '#7BAE7F', '#C4795B', '#8C7BC4', '#C4B45B', '#5BC4B4']


export const LOC_COLORS = {}

function refreshLocColors() {
  for (const k of Object.keys(LOC_COLORS)) delete LOC_COLORS[k]
  LOCATIONS.forEach((l, i) => {
    LOC_COLORS[l.id] = LOC_PALETTE[i % LOC_PALETTE.length]
  })
}
