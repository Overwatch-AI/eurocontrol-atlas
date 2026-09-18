// EUROCONTROL's airspace identifier, shared by icao-codes.js, firs-export.js and
// fir-uir.js so the three datasets can never disagree about what a code means.
//
// It is the ICAO location indicator of the responsible FIC/ACC with FIR or UIR glued on,
// plus an optional sub-area letter: Damascus FIR is carried as OSTTFIR, the halves of the
// Canarias UIR as GCCCUIRN/GCCCUIRS, the upper part of Nuuk as BGGLFIRU. The ICAO code is
// the leading four characters and FIR-vs-UIR is a *type*, not part of the code.
//
// The 4-letter code alone is not a key: 60 indicators carry both an FIR and a UIR, and 31
// collide with an aerodrome -- HSSS is both Khartoum airport and the Khartoum FIC.
// (code, type, subarea) is unique; code is not.
//
// This is also the only way to tell an FIR from a UIR. The [FU]IR geojson carries an
// `airspace_type` field, but it is the constant "FIR" on every feature including the ones
// ending in UIR, so it cannot be used.
const AIRSPACE_ID = /^([A-Z]{4})(FIR|UIR)([A-Z]?)$/

function parseAirspaceId (id) {
  const m = AIRSPACE_ID.exec(id)
  // BODO, EGGX, LPPO and XXXX do not follow the pattern and are not [FU]IRs anyway
  if (!m) return { code: id, type: 'OTHER', subarea: null }
  return { code: m[1], type: m[2], subarea: m[3] || null }
}

module.exports = { AIRSPACE_ID, parseAirspaceId }
