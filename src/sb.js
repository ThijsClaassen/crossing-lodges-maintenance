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

export const LOCATIONS = [
  { id: 'ZC', name: 'Zebras Crossing' },
  { id: 'EC', name: 'Elephants Crossing' },
  { id: 'SC', name: 'Schamach' },
]
export const LOC_COLORS = { ZC: '#B8935A', EC: '#5B8CC4', SC: '#7BAE7F' }
