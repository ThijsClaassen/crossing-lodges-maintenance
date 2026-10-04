// phone_menu_test.mjs — the phone menu sheet must be readable (2026-10-04).
//
//   node tools/phone_menu_test.mjs
//
// Thijs, phone photo in sunlight: "The UX on the phones are not good … the
// menu beam." The sheet had been turned navy, but its items kept --cream
// (near-black in light mode) and its header the white page panel. This reads
// the stylesheet the way the browser does — the LAST rule for a property
// wins — and checks every part of the sheet ends up on the rail palette,
// with real contrast in both modes.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// theme.js is a template string: ${T.cream} becomes tpl:T.cream so the braces
// don't upset the rule parser, and a page colour still shows as one.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'theme.js'), 'utf8').replace(/\$\{([^}]*)\}/g, 'tpl:$1')
let passed = 0
const failures = []
const check = (name, ok, detail) => (ok ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`))

// The final value of `prop` for an exact selector (comma lists included).
function finalValue(selector, prop) {
  let value = null
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(css))) {
    const sels = m[1].split(',').map((s) => s.trim().replace(/^.*\n\s*/s, ''))
    if (!sels.includes(selector)) continue
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':')
      if (i < 0) continue
      if (decl.slice(0, i).trim() === prop) value = decl.slice(i + 1).trim()
    }
  }
  return value
}

const token = (name, mode) => {
  // light = the first :root block's value, dark = the second definition.
  const all = [...css.matchAll(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`, 'g'))].map((x) => x[1])
  return mode === 'dark' ? all[1] || all[0] : all[0]
}
const lum = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

const PARTS = [
  ['.nav-sheet', 'background', 'var(--sidebar-bg)'],
  ['.nav-sheet-header', 'background', 'var(--sidebar-bg)'],
  ['.nav-sheet-title', 'color', 'var(--sidebar-text)'],
  ['.nav-sheet-close', 'color', 'var(--sidebar-text)'],
  ['.nav-sheet-item', 'color', 'var(--sidebar-text)'],
  ['.nav-sheet .nav-section', 'color', 'var(--sidebar-text)'],
  ['.nav-sheet-item.active', 'color', 'var(--accent-on-dark)'],
]
for (const [sel, prop, want] of PARTS) {
  const got = finalValue(sel, prop)
  check(`${sel} ends on ${prop}: ${want}`, got === want, `got ${got}`)
}
check('no page colours (--cream / --panel) win on the sheet', !['.nav-sheet-item', '.nav-sheet-close', '.nav-sheet-title'].some((s) => /cream|panel/.test(finalValue(s, 'color') || '')) && !/panel/.test(finalValue('.nav-sheet-header', 'background') || ''))
check('menu rows are a thumb-sized 16px', finalValue('.nav-sheet-item', 'font-size') === '16px')
for (const mode of ['light', 'dark']) {
  const bg = token('--sidebar-bg', mode)
  const fg = token('--sidebar-text', mode)
  const r = contrast(fg, bg)
  check(`${mode} mode: menu text on the sheet is at least 7:1 (outdoor AAA)`, r >= 7, `${fg} on ${bg} = ${r.toFixed(2)}:1`)
}

console.log(`phone_menu_test: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
