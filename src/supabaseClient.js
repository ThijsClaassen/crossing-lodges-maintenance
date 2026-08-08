// Real Supabase Auth client — added 2026-08-08 for Maintenance 3b of the
// multi-tenant rebuild. Same project as Finance Dashboard/Food Stock/
// HR-Linen/Ops, so the URL/key are the same values, just duplicated here
// since each app is its own deploy with no shared package.
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || 'https://arrendpmuwdhrfwvokhv.supabase.co'
const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_e5hLLlXWBVV8NkNUAz3Blg_8oMwP3Wt'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
export { SUPABASE_URL, SUPABASE_ANON_KEY }
