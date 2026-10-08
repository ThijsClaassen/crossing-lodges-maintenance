// Item pickers search all items before a category is chosen (2026-10-08).
// Thijs: "always search items, also if you didn't submit a category yet. So
// first item list will show all items, only when you submit a category it
// will limit it." Maintenance has two: Log Issue and job materials.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = readFileSync(join(ROOT, 'src', 'App.jsx'), 'utf8')
const failures = []; let passed = 0
const check = (n, ok) => (ok ? passed++ : failures.push(n))

check('no picker waits for a category any more', !/Pick a category first/.test(app) && !/disabled=\{!category\}/.test(app) && !/disabled=\{!r\.category\}/.test(app))
check('Log Issue: no category = all items', /const itemsInCat = category\s*\? items\.filter\(it => inCategory\(it, category\)\)\s*: items;/.test(app))
check('materials: no category = all items', /const itemsInCat = r\.category\s*\? items\.filter\(it => inCategory\(it, r\.category\)\)\s*: items;/.test(app))
check('both pickers say "Search all items…" with no category, and "All categories" is the first choice', (app.match(/"Search all items…"/g) || []).length === 2 && (app.match(/<option value="">All categories<\/option>/g) || []).length === 2)
check('item labels show their category while searching across all', (app.match(/\$\{!category&&i\.category\?`\$\{i\.category\} · `:""\}/g) || []).length === 1 && (app.match(/\$\{!r\.category&&it\.category\?`\$\{it\.category\} · `:""\}/g) || []).length === 1)
check('changing the category keeps a chosen item that is in it', /return c&&it&&!inCategory\(it,c\)\?\{\.\.\.p,item_id:""\}:p;/.test(app) && /item_id: cat && it && !inCategory\(it,cat\) \? "" : x\.item_id/.test(app))

// Behaviour of the filter itself.
const inCategory = (it, c) => (c === '__none__' ? !it.category : it.category === c)
const items = [{ id: 1, category: 'Plumbing' }, { id: 2, category: 'Electrical' }, { id: 3, category: '' }]
const pick = (c) => (c ? items.filter((it) => inCategory(it, c)) : items).map((i) => i.id).join()
check('filter: none → all 3; Plumbing → 1; Uncategorised → 3', pick('') === '1,2,3' && pick('Plumbing') === '1' && pick('__none__') === '3')

console.log(`item_picker_test: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
