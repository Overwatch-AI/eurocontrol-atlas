#!/usr/bin/env node
// Publish the [FU]IR polygons of the current AIRAC cycle, with the airspace identifier
// decomposed the same way icao-codes and firs-all decompose it.
//
// Usage: fir-uir.js <current.geojson> <out.geojson>

const fs = require('fs')
const { parseAirspaceId } = require('./airspace-id.js')

const [inFile, outFile] = process.argv.slice(2)
if (!inFile || !outFile) {
  console.error('usage: fir-uir.js <current.geojson> <out.geojson>')
  process.exit(2)
}

const source = JSON.parse(fs.readFileSync(inFile, 'utf8'))

// One shape per identifier and flight-level band. The source republishes a shape under an
// alternate name and NM object id -- Gander appears as both GANDER NAT RVSM and GANDER
// FLIGHT INFORMATION REGION -- and firs-export keeps the first row of each, so keep the
// first here too or the two datasets would name the same region differently.
const byKey = new Map()
for (const feature of source.features) {
  const p = feature.properties
  const key = `${p.code}/${p.min_fl}/${p.max_fl}`
  const geometry = JSON.stringify(feature.geometry)
  const existing = byKey.get(key)
  if (existing) {
    // the whole point of dropping a repeat is that it carries nothing new
    if (existing.geometry !== geometry) {
      console.error(`FATAL: ${key} is published with two different shapes`)
      process.exit(1)
    }
    existing.dropped++
    continue
  }
  const { code, type, subarea } = parseAirspaceId(p.code)
  byKey.set(key, {
    geometry,
    dropped: 0,
    feature: {
      type: 'Feature',
      properties: {
        airac_cfmu: p.airac_cfmu,
        airspace_id: p.code,
        code,
        type,
        subarea,
        name: p.name || null,
        icao_state: p.icao,
        // NM object id, first of several where a repeat was dropped
        id: p.id,
        min_fl: p.min_fl,
        max_fl: p.max_fl
      },
      geometry: feature.geometry
    }
  })
}

const features = [...byKey.values()]
const dropped = features.reduce((a, e) => a + e.dropped, 0)

// one compact feature per line, as the source ships it: a pretty-printed coordinate list
// triples the file and makes a boundary change unreadable in a diff
fs.writeFileSync(outFile, [
  '{',
  '"type": "FeatureCollection",',
  `"name": ${JSON.stringify(source.name)},`,
  `"crs": ${JSON.stringify(source.crs)},`,
  '"features": [',
  features.map(e => JSON.stringify(e.feature)).join(',\n'),
  ']',
  '}',
  ''
].join('\n'))

const tally = features.reduce((a, e) => (a[e.feature.properties.type] = (a[e.feature.properties.type] || 0) + 1, a), {})
console.error(`${source.features.length} features -> ${features.length} shapes (${dropped} repeats dropped) -> ${outFile}`)
console.error(`  by type: ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' ')}`)
