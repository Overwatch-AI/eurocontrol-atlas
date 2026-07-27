#!/usr/bin/env node
// Consolidate every Information Region of the current AIRAC cycle into one flat
// CSV + JSON, enriched from the lookup tables in data/, and reconcile it against
// the legacy CFMU 406 snapshot in zip/FirUir_NM.zip.
//
// Usage: firs-export.js <current.geojson> <baseline.csv> <out.csv> <out.json> <diff.csv>
//
//   <current.geojson>  ir-<airac>.geojson from euctrl-pru/pruatlas (the reference set)
//   <baseline.csv>     ogr2ogr CSV dump of the unfiltered 406 shapefile (diff baseline)
//
// Env: AIRAC (cycle of the current set), BASELINE_DATE (vintage of the 406 export).

const fs = require('fs')
const path = require('path')

const DATA = path.join(__dirname, '..', 'data')

// minimal RFC4180 reader: enough for the comma-separated lookup tables in data/
// and for ogr2ogr's CSV output (which quotes any field containing , " or \n)
function parseCsv (text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else { quoted = false }
      } else { field += c }
    } else if (c === '"') {
      quoted = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\n') {
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else if (c !== '\r') {
      field += c
    }
  }
  row.push(field)
  if (row.length > 1 || row[0] !== '') rows.push(row)
  return rows
}

function readTable (file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'))
  const header = rows.shift()
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])))
}

// ---- lookups -------------------------------------------------------------

// ICAO state prefix -> Eurocontrol member state (name, iso2, entry date)
const members = new Map()
for (const m of readTable(path.join(DATA, 'eurocontrol.csv'))) {
  members.set(m.icao, {
    country: m.name,
    iso2: m.iso2,
    eurocontrol_entry: m.date === 'NA' ? null : m.date
  })
}

// FAB id -> FAB name. NOTE: fab-id-name.csv is headerless, so no readTable here.
const fabNames = new Map(
  parseCsv(fs.readFileSync(path.join(DATA, 'fab-id-name.csv'), 'utf8'))
    .map(([id, name]) => [id, name])
)
const fabOfState = new Map()
for (const f of readTable(path.join(DATA, 'fabstates.ses.csv'))) {
  fabOfState.set(f.AV_ICAO_ST, fabNames.get(f.fab) || null)
}

// NOTE: `country` can only be filled for Eurocontrol member states -- data/ has no
// ICAO-prefix -> country mapping for the rest of the world, so those stay null.

// What the source calls `code` is EUROCONTROL's airspace identifier: the ICAO location
// indicator of the responsible FIC/ACC with FIR or UIR glued on, plus an optional
// sub-area letter. Damascus FIR is carried as OSTTFIR, so the ICAO code is OSTT and the
// FIR/UIR part is a *type*. GCCCUIRN/GCCCUIRS are the north/south halves of the
// Canarias UIR; BGGLFIRU is the upper part of Nuuk.
//
// The source's own `airspace_type` is the constant "FIR" for every feature, including
// the codes ending in UIR, so it is useless as a discriminator -- derive from the
// identifier instead. What does not match is genuinely not an [FU]IR: BODO, the
// EGGX/LPPO rerouting extensions and the XXXX "no FIR" placeholder.
const AIRSPACE_ID = /^([A-Z]{4})(FIR|UIR)([A-Z]?)$/

function parseAirspaceId (id) {
  const m = AIRSPACE_ID.exec(id)
  if (!m) return { code: id, type: 'OTHER', subarea: null }
  return { code: m[1], type: m[2], subarea: m[3] || null }
}

// ---- inputs --------------------------------------------------------------

const [currentFile, baselineFile, outCsv, outJson, outDiff] = process.argv.slice(2)
if (!currentFile || !baselineFile || !outCsv || !outJson || !outDiff) {
  console.error('usage: firs-export.js <current.geojson> <baseline.csv> <out.csv> <out.json> <diff.csv>')
  process.exit(2)
}

const airac = process.env.AIRAC || null
const baselineDate = process.env.BASELINE_DATE || null

// current reference set: one entry per code. The source already carries a clean
// schema (code, icao, name, min_fl, max_fl, airspace_type), but a few regions are
// split into several features by flight-level band, so merge those into one range.
const byCode = new Map()
for (const feat of JSON.parse(fs.readFileSync(currentFile, 'utf8')).features) {
  const p = feat.properties
  const airspaceId = p.code
  // keyed on the NM identifier: the bare ICAO code is not unique, since an indicator
  // commonly carries both an FIR and a UIR (EGTTFIR/EGTTUIR both reduce to EGTT)
  const existing = byCode.get(airspaceId)
  if (existing) {
    existing.min_fl = Math.min(existing.min_fl, p.min_fl)
    existing.max_fl = Math.max(existing.max_fl, p.max_fl)
    existing.source_features++
    continue
  }
  const { code, type, subarea } = parseAirspaceId(airspaceId)
  const state = p.icao
  const member = members.get(state)
  byCode.set(airspaceId, {
    code,
    type,
    subarea,
    airspace_id: airspaceId,
    name: p.name || null,
    icao_state: state,
    country: member ? member.country : null,
    iso2: member ? member.iso2 : null,
    eurocontrol_member: Boolean(member),
    eurocontrol_entry: member ? member.eurocontrol_entry : null,
    fab: fabOfState.get(state) || null,
    min_fl: p.min_fl,
    max_fl: p.max_fl,
    airac_cfmu: p.airac_cfmu,
    source_features: 1
  })
}
const firs = [...byCode.values()].sort((a, b) =>
  a.code.localeCompare(b.code) ||
  a.type.localeCompare(b.type) ||
  (a.subarea || '').localeCompare(b.subarea || ''))

// ---- reconciliation against the 406 snapshot -----------------------------

// Both cycles are compared on the NM airspace identifier (AV_AIRSPAC in 406, `code` in
// the geojson), not on the bare ICAO code -- that is the only field that identifies a
// single airspace across cycles, and EGTT alone would conflate the FIR with the UIR.
const baseline = new Map()
for (const r of readTable(baselineFile)) {
  const airspaceId = r.AV_AIRSPAC
  const existing = baseline.get(airspaceId)
  if (existing) {
    existing.min_fl = Math.min(existing.min_fl, Number(r.MIN_FLIGHT))
    existing.max_fl = Math.max(existing.max_fl, Number(r.MAX_FLIGHT))
    continue
  }
  baseline.set(airspaceId, {
    airspace_id: airspaceId,
    code: parseAirspaceId(airspaceId).code,
    name: r.AV_NAME || null,
    icao_state: r.AV_ICAO_ST,
    min_fl: Number(r.MIN_FLIGHT),
    max_fl: Number(r.MAX_FLIGHT)
  })
}

// Neither source caps names (406 tops out at 29 chars, 524 at 35), but both carry a
// few values that were already truncated upstream. Where one name is a strict prefix
// of the other that is almost certainly the artefact, not a real rename, so classify
// it apart rather than reporting it as an editorial change.
const norm = s => (s || '').trim().toUpperCase().replace(/\s+/g, ' ')
function nameChange (oldName, newName) {
  const a = norm(oldName)
  const b = norm(newName)
  if (a === b) return null
  if (a && b && (a.startsWith(b) || b.startsWith(a))) return 'renamed-truncated'
  return 'renamed'
}

const diff = []
const row = (change, e, detail) =>
  ({ change, airspace_id: e.airspace_id, code: e.code, icao_state: e.icao_state, detail })

for (const f of firs) {
  const b = baseline.get(f.airspace_id)
  if (!b) {
    diff.push(row('added', f, f.name || ''))
    continue
  }
  const nc = nameChange(b.name, f.name)
  if (nc) diff.push(row(nc, f, `${b.name || '(none)'} -> ${f.name || '(none)'}`))
  if (b.min_fl !== f.min_fl || b.max_fl !== f.max_fl) {
    diff.push(row('fl-changed', f, `${b.min_fl}-${b.max_fl} -> ${f.min_fl}-${f.max_fl}`))
  }
  if (b.icao_state !== f.icao_state) {
    diff.push(row('state-changed', f, `${b.icao_state} -> ${f.icao_state}`))
  }
}
for (const b of baseline.values()) {
  if (!byCode.has(b.airspace_id)) diff.push(row('removed', b, b.name || ''))
}
diff.sort((a, b) => a.change.localeCompare(b.change) || a.airspace_id.localeCompare(b.airspace_id))

// ---- write ---------------------------------------------------------------

const COLUMNS = [
  'code', 'type', 'subarea', 'name', 'icao_state', 'country', 'iso2',
  'eurocontrol_member', 'eurocontrol_entry', 'fab',
  'min_fl', 'max_fl', 'airspace_id', 'airac_cfmu', 'source_features'
]

const csvCell = v => {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const toCsv = (cols, rows) =>
  [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n'

fs.writeFileSync(outCsv, toCsv(COLUMNS, firs))
fs.writeFileSync(outDiff, toCsv(['change', 'airspace_id', 'code', 'icao_state', 'detail'], diff))

fs.writeFileSync(outJson, JSON.stringify({
  source: `EUROCONTROL PRISME [FU]IR export, CFMU AIRAC cycle ${airac}, via euctrl-pru/pruatlas (ir-${airac}.geojson)`,
  airac_cfmu: airac ? Number(airac) : null,
  baseline: `CFMU AIRAC cycle 406 (${baselineDate}), zip/FirUir_NM.zip`,
  count: firs.length,
  firs
}, null, 2) + '\n')

const tally = (rows, key) => rows.reduce((a, r) => (a[r[key]] = (a[r[key]] || 0) + 1, a), {})
const fmt = o => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')
console.error(`AIRAC ${airac}: ${firs.length} regions -> ${outCsv}, ${outJson}`)
console.error(`  by type: ${fmt(tally(firs, 'type'))}`)
console.error(`  eurocontrol members: ${firs.filter(f => f.eurocontrol_member).length}   with a FAB: ${firs.filter(f => f.fab).length}`)
console.error(`vs 406 (${baselineDate}): ${diff.length} changes -> ${outDiff}`)
console.error(`  ${fmt(tally(diff, 'change'))}`)
