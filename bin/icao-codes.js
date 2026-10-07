#!/usr/bin/env node
// Build one ICAO code -> {name, city, country} lookup covering both the [FU]IRs of
// the current AIRAC cycle and every aerodrome/station in the NOAA AWC station cache,
// topped up from OurAirports with the IATA codes and aerodromes the cache lacks.
//
// Usage: icao-codes.js <ir.geojson> <stations.json> <ourairports.csv> <out.json> <out.csv>
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

const [irFile, stationsFile, ourAirportsFile, outJson, outCsv] = process.argv.slice(2)
if (!irFile || !stationsFile || !ourAirportsFile || !outJson || !outCsv) {
  console.error('usage: icao-codes.js <ir.geojson> <stations.json> <ourairports.csv> <out.json> <out.csv>')
  process.exit(2)
}

const airac = process.env.AIRAC ? Number(process.env.AIRAC) : null
// `country_name` is the conventional ASCII form, not CLDR's current preference: see the
// rationale in countries.js. CLDR names and match aliases live in the `countries` table
// emitted once in the envelope.
const { conventionalName: countryName, countryTable, normalizeCountryCode } = require('./countries.js')

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

// ---- alternate IATA codes (curated, from data/) ---------------------------

// The station cache carries exactly one `iataId` per station, but an aerodrome can hold
// more than one IATA *airport* code: LFSB is binational, so EuroAirport is BSL on the
// Swiss side and MLH on the French one, and both are live for booking and billing. The
// cache happens to give MLH, which left BSL unfindable. Codes are emitted one row each,
// `rank` first, so the primary code leads.
//
// Airport codes only. IATA metropolitan area codes (EAP for Basel, NYC, LON, PAR) are a
// separate namespace and are many-to-one -- LON alone covers seven London aerodromes --
// so they are deliberately absent rather than mixed into `iata`.
const altIata = new Map()
for (const r of readTable(path.join(DATA, 'iata-alt.csv'))) {
  if (!altIata.has(r.icao)) altIata.set(r.icao, [])
  altIata.get(r.icao).push({ iata: r.iata, rank: Number(r.rank) })
}
for (const list of altIata.values()) list.sort((a, b) => a.rank - b.rank)

// the curated list wins on order, but never silently drops what the upstream knows.
// Each code carries where it came from, published as `iata_source`.
function iataCodes (code, upstream, source) {
  const alt = altIata.get(code)
  if (!alt) return [{ iata: upstream || null, source: upstream ? source : null }]
  const codes = alt.map(a => ({ iata: a.iata, source: a.iata === upstream ? source : 'iata-alt' }))
  if (upstream && !codes.some(c => c.iata === upstream)) codes.push({ iata: upstream, source })
  return codes
}

// ---- contested IATA codes (curated, from data/) ---------------------------

// OurAirports (below) can hand out an IATA code the station cache already gives to a
// different aerodrome. Neither upstream is reliably the newer one, so the build refuses
// to guess: every such code must be settled here, by naming the ICAO indicator(s) that
// own it. The code is then taken off every other holder.
const iataOwners = new Map()
for (const r of readTable(path.join(DATA, 'iata-owner.csv'))) {
  if (!iataOwners.has(r.iata)) iataOwners.set(r.iata, new Set())
  iataOwners.get(r.iata).add(r.icao)
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
const AERODROME_WORDS = 'intl|international|arpt|aprt|airport|airfield|airpark|muni|' +
  'municipal|rgnl|regional|afb|aaf|afs|nas|naf|mil|ab|cnty|county|exec|executive|mem|' +
  'memorial|fld|field|hlpt|heliport|spb'
const AERODROME_TAIL = new RegExp(`[\\s,]*\\b(${AERODROME_WORDS})\\b\\.?[\\s,]*$`, 'i')
// the same dressing, bracketed: "Fort Campbell Arpt(AAF)". Only a lone aerodrome word
// inside the brackets qualifies -- anything else there is part of the name.
const AERODROME_BRACKET = new RegExp(`\\s*\\(\\s*(?:${AERODROME_WORDS})\\s*\\)\\s*$`, 'i')

// Both upstreams truncate long names in place, which leaves punctuation behind that is
// not part of any name: an orphan bracket at the seam (`Culdrose )`, `Yeovilton Arpt)`,
// `DAKAR TERRESTRE (PAR`), or -- once a trailing aerodrome/airspace word is stripped --
// the separator that joined it on (`Battle Mountain+ Arpt`, `MIAMI FIR / UIR`). Trimming
// is edge-only, so N'Djamena, Port-au-Prince and Kiel/Holtenau come through whole.
const EDGE_PUNCT = /^[\s\-/,;:+?!#&*_'"]+|[\s\-/,;:+?!#&*_'"]+$/g
const trimPunct = s => s.replace(EDGE_PUNCT, '')

// A lone `)` lost its opener, so only the bracket goes. A lone `(` means the
// parenthetical itself was cut off, so everything from it goes. Balanced pairs are
// content and are left alone: `Fort Campbell Arpt(AAF)`.
function dropOrphanParens (s) {
  const open = []
  let out = ''
  for (const c of s) {
    if (c === '(') { open.push(out.length); out += c } else if (c === ')') {
      if (open.length) { open.pop(); out += c }
    } else out += c
  }
  return open.length ? out.slice(0, open[0]) : out
}

const tidy = s => trimPunct(dropOrphanParens(s).replace(/\s+/g, ' '))

function splitSite (site) {
  if (!site) return { city: null, aerodrome: null, source: null }
  const clean = tidy(site)
  if (!clean) return { city: null, aerodrome: null, source: null }
  const i = clean.indexOf('/')
  if (i !== -1) {
    return {
      city: trimPunct(clean.slice(0, i)) || null,
      aerodrome: trimPunct(clean.slice(i + 1)) || null,
      source: 'site-city'
    }
  }
  let place = clean
  let prev
  do {
    prev = place
    place = trimPunct(place.replace(AERODROME_BRACKET, '').replace(AERODROME_TAIL, ''))
  } while (place && place !== prev)
  return {
    city: place || null,
    aerodrome: clean,
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
  // fold AWC's non-ISO codes (KV -> XK) before anything keys off the country
  const country = normalizeCountryCode(s.country)
  if (code && code.length === 4 && country) {
    for (const n of [2, 3, 4]) {
      const p = code.slice(0, n)
      if (!prefixCountry.has(p)) prefixCountry.set(p, new Map())
      const c = prefixCountry.get(p)
      c.set(country, (c.get(country) || 0) + 1)
    }
  }
  if (country && city) {
    if (!citiesByCountry.has(country)) citiesByCountry.set(country, new Map())
    // "City/Aerodrome" wins over a stripped bare name when both offer the same key
    const known = citiesByCountry.get(country)
    const key = city.toUpperCase()
    if (!known.has(key) || citySource === 'site-city') known.set(key, city)
  }
  // one row per IATA airport code: an aerodrome with two live codes gets two rows,
  // identical but for `iata`, which is why `iata` is part of the key
  if (code && code.length === 4) {
    for (const { iata, source: iataSource } of iataCodes(code, s.iataId, 'awc-station-cache')) {
      airports.push({
        code,
        type: 'AIRPORT',
        name: aerodrome || s.site || null,
        city: city,
        country: country,
        country_name: countryName(country),
        lat: s.lat,
        lon: s.lon,
        elev_m: s.elev,
        iata,
        iata_source: iataSource,
        state_code: s.state || null,
        site_types: (s.siteType || []).join('|') || null,
        city_source: citySource,
        source: 'awc-station-cache'
      })
    }
  }
}

// ---- OurAirports: the IATA codes and aerodromes the station cache lacks ------

// The cache lists only aerodromes with a weather station, and only about half of them
// carry an IATA code. OurAirports (public domain, ~9k IATA codes) tops it up and never
// overrides it: an AWC row keeps its name, city and position, and only gains a code
// where it had none. Airports added from here have no station behind them, so their
// `site_types` is null -- a row existing does not mean the aerodrome has weather.
// They are also kept out of the prefix and city indexes above, so region resolution
// is exactly what the cache alone gives.
//
// OurAirports fills `icao_code` only for verified assignments; where it is blank,
// `gps_code` is usually the ICAO indicator (BGAG, AYFE). Either names a new row if it
// is four letters. Anything else -- an FAA identifier like 06U, a local code -- is not
// an ICAO indicator, so that airport stays out rather than bend what `code` means.
// `ident` is OurAirports' own id and is sometimes the *old* indicator (LELO for what is
// now LERJ): it helps recognise an aerodrome the cache already has, but never names one.
const ICAO_LIKE = /^[A-Z]{4}$/
// closer than this is the same aerodrome: the cache rounds positions to ~100 m, and
// the largest fields are a few km across
const SAME_FIELD_KM = 10
const km = (a, b) => {
  const r = Math.PI / 180
  const h = Math.sin((b.lat - a.lat) * r / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2
  return 12742 * Math.asin(Math.sqrt(h))
}

const rowsByCode = new Map()
const rowsByIata = new Map()
const indexIata = row => {
  if (!rowsByIata.has(row.iata)) rowsByIata.set(row.iata, [])
  rowsByIata.get(row.iata).push(row)
}
const index = row => {
  if (!rowsByCode.has(row.code)) rowsByCode.set(row.code, [])
  rowsByCode.get(row.code).push(row)
  if (row.iata) indexIata(row)
}
for (const a of airports) index(a)

const merged = { filled: 0, second_code: 0, added: 0, known: 0, same_field: 0, no_icao: 0 }
const moved = []
for (const o of readTable(ourAirportsFile)) {
  const iata = o.iata_code
  if (!iata || o.type === 'closed') continue
  const pos = { lat: Number(o.latitude_deg), lon: Number(o.longitude_deg) }
  const known = [o.icao_code, o.ident, o.gps_code].find(k => ICAO_LIKE.test(k) && rowsByCode.has(k))
  if (known) {
    const rows = rowsByCode.get(known)
    if (rows.some(r => r.iata === iata)) { merged.known++; continue }
    // the indicator now belongs to a different aerodrome than the one the cache
    // describes (Indonesia renumbered its WA.. indicators): attaching the code would
    // put it at the wrong place
    if (km(rows[0], pos) > SAME_FIELD_KM) { moved.push(`${known}=${iata}`); continue }
    const blank = rows.find(r => !r.iata)
    if (blank) {
      blank.iata = iata
      blank.iata_source = 'ourairports'
      indexIata(blank)
      merged.filled++
      continue
    }
    // a second live code for the same field, usually a recode the cache has not caught
    // up with (Chisinau KIV -> RMO): both stay findable, the cache's first, exactly as
    // an iata-alt.csv entry would
    const row = { ...rows[rows.length - 1], iata, iata_source: 'ourairports' }
    airports.push(row)
    index(row)
    merged.second_code++
    continue
  }
  // the code already resolves to an aerodrome right here, under another indicator:
  // a military/civil pair (ETNU/EDBN) or a renumbering (WIIJ/WAHH). Nothing is missing.
  if ((rowsByIata.get(iata) || []).some(r => km(r, pos) <= SAME_FIELD_KM)) { merged.same_field++; continue }
  const code = [o.icao_code, o.gps_code].find(k => ICAO_LIKE.test(k))
  if (!code) { merged.no_icao++; continue }
  const country = normalizeCountryCode(o.iso_country || null)
  const elevFt = o.elevation_ft === '' ? NaN : Number(o.elevation_ft)
  for (const { iata: rowIata, source: iataSource } of iataCodes(code, iata, 'ourairports')) {
    const row = {
      code,
      type: 'AIRPORT',
      name: o.name || null,
      city: o.municipality || null,
      country,
      country_name: countryName(country),
      lat: pos.lat,
      lon: pos.lon,
      elev_m: Number.isNaN(elevFt) ? null : Math.round(elevFt * 0.3048),
      iata: rowIata,
      iata_source: iataSource,
      // `iso_region` is real ISO 3166-2, which `state_code` deliberately is not
      state_code: null,
      site_types: null,
      city_source: o.municipality ? 'ourairports' : null,
      source: 'ourairports'
    }
    airports.push(row)
    index(row)
  }
  merged.added++
}

// Settle contested codes from iata-owner.csv: take the code off every holder that is not
// a named owner. A row left with no code is kept unless the aerodrome still has another
// row with one, since `iata` is a key column and two null-coded rows would collide.
const dropped = new Set()
for (const [iata, owners] of iataOwners) {
  for (const r of rowsByIata.get(iata) || []) {
    if (owners.has(r.code)) continue
    const others = rowsByCode.get(r.code).filter(x => x !== r && !dropped.has(x) && x.iata)
    if (others.length) dropped.add(r)
    else { r.iata = null; r.iata_source = null }
  }
  for (const owner of owners) {
    if (!(rowsByIata.get(iata) || []).some(r => r.code === owner && r.iata === iata)) {
      console.error(`FATAL: iata-owner.csv names ${owner} for ${iata}, which no upstream gives it. Stale entry?`)
      process.exit(1)
    }
  }
}

// An IATA code on more than one aerodrome is ambiguous to anyone resolving it. The cache
// has a few of its own (an old and a new indicator for one field) and they are left
// alone, but one that OurAirports introduced must be settled in iata-owner.csv first.
const unsettled = []
for (const [iata, rows] of rowsByIata) {
  const live = rows.filter(r => !dropped.has(r) && r.iata === iata)
  if (new Set(live.map(r => r.code)).size < 2 || iataOwners.has(iata)) continue
  if (live.some(r => r.iata_source === 'ourairports')) {
    unsettled.push(`${iata}: ${live.map(r => `${r.code} (${r.iata_source}, ${r.name})`).join(' vs ')}`)
  }
}
if (unsettled.length) {
  console.error(`FATAL: ${unsettled.length} IATA code(s) held by more than one aerodrome, ` +
    'introduced by OurAirports. Name the owner(s) in data/iata-owner.csv:')
  for (const u of unsettled) console.error(`  ${u}`)
  process.exit(1)
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

// EUROCONTROL's airspace identifier is the ICAO location indicator of the responsible
// FIC/ACC with FIR or UIR glued on. The original is kept as `airspace_id` for
// traceability back into the NM data.
const { parseAirspaceId } = require('./airspace-id.js')

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
  let stripped = tidy(name.replace(AIRSPACE_WORDS, ' '))
  let prev
  do { prev = stripped; stripped = trimPunct(stripped.replace(TRAILING_QUALIFIER, '')) } while (stripped && stripped !== prev)
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
  const airspaceId = p.code
  // keyed on the NM identifier, which stays unique where the bare ICAO code does not
  const existing = regions.get(airspaceId)
  if (existing) {
    existing.min_fl = Math.min(existing.min_fl, p.min_fl)
    existing.max_fl = Math.max(existing.max_fl, p.max_fl)
    continue
  }
  const { code, type, subarea } = parseAirspaceId(airspaceId)
  // resolve country off the full identifier: its first 2-4 chars are the ICAO prefix
  const { country, matched_prefix } = resolveCountry(airspaceId)
  const { city, city_source } = regionCity(p.name, country)
  const center = feat.geometry ? bboxCenter(feat.geometry) : { lat: null, lon: null }
  regions.set(airspaceId, {
    code,
    type,
    subarea,
    airspace_id: airspaceId,
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

// two rows of the same aerodrome compare equal here; Array#sort is stable, so they stay
// in the order `iataCodes` produced them and the primary IATA code leads
const entries = [...regions.values(), ...airports.filter(a => !dropped.has(a))]
  .sort((a, b) =>
    a.code.localeCompare(b.code) ||
    a.type.localeCompare(b.type) ||
    (a.subarea || '').localeCompare(b.subarea || ''))

const COLUMNS = [
  'code', 'type', 'subarea', 'name', 'city', 'country', 'country_name', 'lat', 'lon',
  'iata', 'iata_source', 'icao_state', 'min_fl', 'max_fl', 'eurocontrol_member', 'fab',
  'elev_m', 'state_code', 'site_types', 'city_source', 'country_prefix',
  'airspace_id', 'airac_cfmu', 'source'
]
const cell = v => {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// (code, type, subarea, iata) is the documented key. Fail loudly rather than emit a file
// whose rows silently collide -- `code` alone is deliberately not unique, and neither is
// (code, type, subarea) once an aerodrome with two live IATA codes gets a row per code.
const seen = new Set()
for (const e of entries) {
  const key = `${e.code} ${e.type} ${e.subarea || ''} ${e.iata || ''}`
  if (seen.has(key)) {
    console.error('FATAL: duplicate (code, type, subarea, iata): ' +
      `${e.code} ${e.type} ${e.subarea || '-'} ${e.iata || '-'}`)
    process.exit(1)
  }
  seen.add(key)
}
fs.writeFileSync(outCsv,
  [COLUMNS.join(','), ...entries.map(e => COLUMNS.map(c => cell(e[c])).join(','))].join('\n') + '\n')

fs.writeFileSync(outJson, JSON.stringify({
  sources: {
    regions: `EUROCONTROL PRISME [FU]IR export, CFMU AIRAC cycle ${airac}, via euctrl-pru/pruatlas`,
    airports: 'NOAA Aviation Weather Center station cache (aviationweather.gov/data/cache)',
    // only where the cache has no IATA code, or no row at all; tagged `source`/`iata_source`
    ourairports: 'OurAirports airports.csv, public domain (ourairports.com/data)'
  },
  airac_cfmu: airac,
  counts: entries.reduce((a, e) => (a[e.type] = (a[e.type] || 0) + 1, a), {}),
  total: entries.length,
  // `counts` and `total` are row counts, and an aerodrome holding two live IATA codes
  // occupies two rows -- count distinct `code` if you want aerodromes.
  row_key: '(code, type, subarea, iata)',
  // join on `country` (ISO 3166-1 alpha-2). Resolve however a question phrases a country
  // through `aliases` here rather than string-matching `country_name` on the rows.
  key: 'match a country via countries[<iso2>].aliases; rows join on `country`',
  countries: countryTable(entries.map(e => e.country)),
  entries
}, null, 2) + '\n')

// ---- report --------------------------------------------------------------

const regionList = [...regions.values()]
const pct = (n, d) => `${n}/${d} (${Math.round(100 * n / d)}%)`
const fmt = o => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')
const distinct = new Set(entries.map(e => e.code)).size
const extra = entries.length - new Set(entries.map(e => `${e.code} ${e.type} ${e.subarea || ''}`)).size
console.error(`${entries.length} rows, ${distinct} distinct codes -> ${outJson}, ${outCsv}` +
  (extra ? ` (${extra} extra row(s) for aerodromes with a second IATA code)` : ''))
console.error(`  ${fmt(entries.reduce((a, e) => (a[e.type] = (a[e.type] || 0) + 1, a), {}))}`)
console.error(`regions: country ${pct(regionList.filter(r => r.country).length, regionList.length)}` +
  `, city ${pct(regionList.filter(r => r.city).length, regionList.length)}` +
  ` (${fmt(regionList.reduce((a, r) => (a[r.city_source || 'none'] = (a[r.city_source || 'none'] || 0) + 1, a), {}))})`)
const airportRows = entries.filter(e => e.type === 'AIRPORT')
console.error(`airports: country ${pct(airportRows.filter(a => a.country).length, airportRows.length)}` +
  `, city ${pct(airportRows.filter(a => a.city).length, airportRows.length)}` +
  `, iata ${pct(new Set(airportRows.filter(a => a.iata).map(a => a.code)).size, new Set(airportRows.map(a => a.code)).size)} of aerodromes` +
  ` (${new Set(airportRows.map(a => a.iata).filter(Boolean)).size} distinct codes)`)
console.error(`ourairports: ${fmt(merged)}`)
if (moved.length) console.error(`  indicator now names another aerodrome, code not attached: ${moved.join(' ')}`)
if (dropped.size || iataOwners.size) console.error(`  iata-owner.csv settled ${iataOwners.size} code(s)`)
// report the NM identifier, not the bare code -- XXXX and XXXXFIR both reduce to XXXX
const noCountry = regionList.filter(r => !r.country).map(r => r.airspace_id)
if (noCountry.length) console.error(`  regions with no country: ${noCountry.join(', ')}`)
