#!/usr/bin/env node
// Build one ICAO code -> {name, city, country} lookup covering both the [FU]IRs of
// the current AIRAC cycle and every aerodrome/station in the NOAA AWC station cache.
//
// Usage: icao-codes.js <ir.geojson> <stations.json> <out.json> <out.csv>
//
// Env: AIRAC (cycle of the [FU]IR set)
//
// The station cache is the authority for city + country. [FU]IR codes are ICAO
// location indicators, so they share the country-and-region prefix with the stations
// underneath them: LFFFFIR and LFPG both start LF (France). Resolving a region's
// country therefore means finding the stations whose indicator shares the longest
// prefix and taking their majority country -- longest-prefix first, because 2 letters
// is not always decisive (UT covers Turkmenistan, Tajikistan *and* Uzbekistan).

const fs = require('fs')
const path = require('path')

const DATA = path.join(__dirname, '..', 'data')

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

const readTable = file => {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'))
  const header = rows.shift()
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])))
}

const [irFile, stationsFile, outJson, outCsv] = process.argv.slice(2)
if (!irFile || !stationsFile || !outJson || !outCsv) {
  console.error('usage: icao-codes.js <ir.geojson> <stations.json> <out.json> <out.csv>')
  process.exit(2)
}

const airac = process.env.AIRAC ? Number(process.env.AIRAC) : null
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
const countryName = cc => {
  if (!cc) return null
  try { const n = regionNames.of(cc); return n === cc ? null : n } catch { return null }
}

// ---- Eurocontrol / FAB enrichment (Europe only, from data/) ---------------

const members = new Map()
for (const m of readTable(path.join(DATA, 'eurocontrol.csv'))) {
  members.set(m.icao, { eurocontrol_entry: m.date === 'NA' ? null : m.date })
}
const fabNames = new Map( // fab-id-name.csv is headerless
  parseCsv(fs.readFileSync(path.join(DATA, 'fab-id-name.csv'), 'utf8')).map(([id, n]) => [id, n])
)
const fabOfState = new Map()
for (const f of readTable(path.join(DATA, 'fabstates.ses.csv'))) {
  fabOfState.set(f.AV_ICAO_ST, fabNames.get(f.fab) || null)
}

// ---- stations ------------------------------------------------------------

const stations = JSON.parse(fs.readFileSync(stationsFile, 'utf8'))

// `country` is ISO 3166-1 alpha-2 and is used as such. `state` is NOT ISO 3166-2 --
// it is a 2-char AWC/NWS subdivision code that only coincides with ISO for the US and
// Canada (ISO uses ENG/SCT/WLS/NIR for the UK and IDF/ARA/... for France, and 207 of
// the values here are a single character). It is carried through verbatim as
// `state_code` and deliberately not resolved or joined against ISO.

// There is no city field at all: it only exists inside `site`, in two shapes --
// "City/Aerodrome Name" for 2454 stations, and a bare place-or-aerodrome name for the
// other 6403. For the bare form, strip the aerodrome-type words off the tail and what
// remains is the place ("Port Moresby Intl" -> "Port Moresby"). Word boundaries keep
// this off real names, so Springfield survives and "Nauru Island" is left whole.
const AERODROME_TAIL = /[\s,]*\b(intl|international|arpt|aprt|airport|airfield|airpark|muni|municipal|rgnl|regional|afb|aaf|afs|nas|naf|mil|ab|cnty|county|exec|executive|mem|memorial|fld|field|hlpt|heliport|spb)\b\.?[\s,]*$/i

function splitSite (site) {
  if (!site) return { city: null, aerodrome: null, source: null }
  const i = site.indexOf('/')
  if (i !== -1) {
    return {
      city: site.slice(0, i).trim() || null,
      aerodrome: site.slice(i + 1).trim() || null,
      source: 'site-city'
    }
  }
  let place = site.trim()
  let prev
  do { prev = place; place = place.replace(AERODROME_TAIL, '').trim() } while (place && place !== prev)
  return {
    city: place || null,
    aerodrome: site.trim(),
    source: place ? 'site-name' : null
  }
}

// prefix (2..4 chars of the ICAO indicator) -> Counter of country codes, and a
// city index per country used to corroborate the city parsed out of a region name
const prefixCountry = new Map()
const citiesByCountry = new Map()
const airports = []

for (const s of stations) {
  const code = s.icaoId
  const { city, aerodrome, source: citySource } = splitSite(s.site)
  if (code && code.length === 4 && s.country) {
    for (const n of [2, 3, 4]) {
      const p = code.slice(0, n)
      if (!prefixCountry.has(p)) prefixCountry.set(p, new Map())
      const c = prefixCountry.get(p)
      c.set(s.country, (c.get(s.country) || 0) + 1)
    }
  }
  if (s.country && city) {
    if (!citiesByCountry.has(s.country)) citiesByCountry.set(s.country, new Map())
    // "City/Aerodrome" wins over a stripped bare name when both offer the same key
    const known = citiesByCountry.get(s.country)
    const key = city.toUpperCase()
    if (!known.has(key) || citySource === 'site-city') known.set(key, city)
  }
  if (code && code.length === 4) {
    airports.push({
      code,
      type: 'AIRPORT',
      name: aerodrome || s.site || null,
      city: city,
      country: s.country || null,
      country_name: countryName(s.country),
      lat: s.lat,
      lon: s.lon,
      elev_m: s.elev,
      iata: s.iataId || null,
      state_code: s.state || null,
      site_types: (s.siteType || []).join('|') || null,
      city_source: citySource,
      source: 'awc-station-cache'
    })
  }
}

const majority = counter => {
  if (!counter) return null
  let best = null
  let bestN = 0
  for (const [k, n] of counter) if (n > bestN) { best = k; bestN = n }
  return best
}

// longest-prefix-first country resolution for an ICAO location indicator
function resolveCountry (code) {
  for (const n of [4, 3, 2]) {
    const hit = prefixCountry.get(code.slice(0, n))
    if (hit) return { country: majority(hit), matched_prefix: code.slice(0, n) }
  }
  return { country: null, matched_prefix: null }
}

// ---- [FU]IRs -------------------------------------------------------------

// A trailing letter is a sub-area qualifier (GCCCUIRN/GCCCUIRS); what is left over
// genuinely is not an [FU]IR (rerouting extensions, the XXXX placeholder).
const classify = code =>
  /UIR[A-Z]?$/.test(code) ? 'UIR' : /FIR[A-Z]?$/.test(code) ? 'FIR' : 'OTHER'

// Region names are mostly just the FIC city ("PARIS FIR"), dressed with airspace words
// and qualifiers. Strip those FIRST -- "EDMONTON FLIGHT INFORMATION REGION" and
// "OAKLAND OCEANIC FIR" both name a city -- and only then decide whether what is left
// is a place at all. Order matters: testing before stripping rejects those two on the
// words REGION and OCEANIC, which are the dressing rather than the content.
const AIRSPACE_WORDS = /\b((UPPER |LOWER )?FLIGHT INFORMATION REGION|INFORMATION REGION|[FU]IR[A-Z]?|OCEANIC|TERRESTRE)\b/g
// qualifiers only ever trail the place name, so anchor them to avoid eating a real
// name like "North Bay"
const TRAILING_QUALIFIER = /[\s,]*\b(UPPER|LOWER|NORTH|SOUTH|EAST|WEST|CENTRAL|AREA|SECTOR|MERGED)\b[\s,]*$/i
// what remains after all that and still is not a place
const NOT_A_CITY = /\b(REGION|MERGED|REST OF|NO FIR|CONTINENTAL|EXTENSION|INTERNATIONAL AIRSPACE|FICTICIOUS)\b/
const titleCase = s => s.toLowerCase().replace(/(^|[\s/'-])([a-z])/g, (_, a, b) => a + b.toUpperCase())

function regionCity (name, country) {
  if (!name) return { city: null, city_source: null }
  let stripped = name.replace(AIRSPACE_WORDS, ' ').replace(/\s+/g, ' ').trim()
  let prev
  do { prev = stripped; stripped = stripped.replace(TRAILING_QUALIFIER, '').trim() } while (stripped && stripped !== prev)
  if (!stripped) return { city: null, city_source: null }
  const known = citiesByCountry.get(country)
  const hit = known && known.get(stripped.toUpperCase())
  if (hit) return { city: hit, city_source: 'station' }
  if (NOT_A_CITY.test(stripped.toUpperCase())) return { city: null, city_source: null }
  return { city: titleCase(stripped), city_source: 'region-name' }
}

const bboxCenter = geom => {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
  const walk = a => {
    if (typeof a[0] === 'number') {
      minX = Math.min(minX, a[0]); maxX = Math.max(maxX, a[0])
      minY = Math.min(minY, a[1]); maxY = Math.max(maxY, a[1])
    } else for (const b of a) walk(b)
  }
  walk(geom.coordinates)
  const r = n => Math.round(n * 1000) / 1000
  return { lat: r((minY + maxY) / 2), lon: r((minX + maxX) / 2) }
}

const regions = new Map()
for (const feat of JSON.parse(fs.readFileSync(irFile, 'utf8')).features) {
  const p = feat.properties
  const code = p.code
  const existing = regions.get(code)
  if (existing) {
    existing.min_fl = Math.min(existing.min_fl, p.min_fl)
    existing.max_fl = Math.max(existing.max_fl, p.max_fl)
    continue
  }
  const { country, matched_prefix } = resolveCountry(code)
  const { city, city_source } = regionCity(p.name, country)
  const center = feat.geometry ? bboxCenter(feat.geometry) : { lat: null, lon: null }
  regions.set(code, {
    code,
    type: classify(code),
    name: p.name || null,
    city,
    country,
    country_name: countryName(country),
    lat: center.lat,
    lon: center.lon,
    icao_state: p.icao,
    min_fl: p.min_fl,
    max_fl: p.max_fl,
    eurocontrol_member: members.has(p.icao),
    fab: fabOfState.get(p.icao) || null,
    city_source,
    country_prefix: matched_prefix,
    airac_cfmu: p.airac_cfmu,
    source: 'eurocontrol-nm'
  })
}

// ---- combine -------------------------------------------------------------

const entries = [...regions.values(), ...airports]
  .sort((a, b) => a.code.localeCompare(b.code) || a.type.localeCompare(b.type))

const COLUMNS = [
  'code', 'type', 'name', 'city', 'country', 'country_name', 'lat', 'lon',
  'iata', 'icao_state', 'min_fl', 'max_fl', 'eurocontrol_member', 'fab',
  'elev_m', 'state_code', 'site_types', 'city_source', 'country_prefix',
  'airac_cfmu', 'source'
]
const cell = v => {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
fs.writeFileSync(outCsv,
  [COLUMNS.join(','), ...entries.map(e => COLUMNS.map(c => cell(e[c])).join(','))].join('\n') + '\n')

fs.writeFileSync(outJson, JSON.stringify({
  sources: {
    regions: `EUROCONTROL PRISME [FU]IR export, CFMU AIRAC cycle ${airac}, via euctrl-pru/pruatlas`,
    airports: 'NOAA Aviation Weather Center station cache (aviationweather.gov/data/cache)'
  },
  airac_cfmu: airac,
  counts: entries.reduce((a, e) => (a[e.type] = (a[e.type] || 0) + 1, a), {}),
  total: entries.length,
  entries
}, null, 2) + '\n')

// ---- report --------------------------------------------------------------

const regionList = [...regions.values()]
const pct = (n, d) => `${n}/${d} (${Math.round(100 * n / d)}%)`
const fmt = o => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')
console.error(`${entries.length} codes -> ${outJson}, ${outCsv}`)
console.error(`  ${fmt(entries.reduce((a, e) => (a[e.type] = (a[e.type] || 0) + 1, a), {}))}`)
console.error(`regions: country ${pct(regionList.filter(r => r.country).length, regionList.length)}` +
  `, city ${pct(regionList.filter(r => r.city).length, regionList.length)}` +
  ` (${fmt(regionList.reduce((a, r) => (a[r.city_source || 'none'] = (a[r.city_source || 'none'] || 0) + 1, a), {}))})`)
console.error(`airports: country ${pct(airports.filter(a => a.country).length, airports.length)}` +
  `, city ${pct(airports.filter(a => a.city).length, airports.length)}`)
const noCountry = regionList.filter(r => !r.country).map(r => r.code)
if (noCountry.length) console.error(`  regions with no country: ${noCountry.join(', ')}`)
