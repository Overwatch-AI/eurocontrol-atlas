// Country naming, shared by icao-codes.js and firs-export.js so the two datasets can
// never disagree about what TR is called.
//
// `Intl.DisplayNames(['en'])` is the base -- it needs no dependency and tracks CLDR --
// but its output is not ideal as the primary string in a machine-read dataset:
//
//   * it follows official renames, so TR is "Türkiye" and CZ is "Czechia"
//   * it abbreviates: "Bosnia & Herzegovina", "St. Kitts & Nevis", "Hong Kong SAR China"
//   * it carries diacritics, which are correct English but awkward to match on
//
// Anything consuming this by generating a filter -- an LLM being the obvious case --
// will overwhelmingly reach for "Turkey", "Czech Republic" or "Hong Kong", and an exact
// comparison against the CLDR form returns nothing while looking like a legitimate
// empty result. So `name` is the conventional ASCII form, `cldr` keeps the standards
// name, and `aliases` carries every variant worth matching. The real join key remains
// the ISO 3166-1 alpha-2 code.

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })

// The AWC station cache uses a few codes that are not ISO 3166-1. KV is its code for
// Kosovo, where the user-assigned ISO code -- and what data/eurocontrol.csv already
// carries -- is XK. Without this, Pristina resolves to a country with no name at all.
const NON_ISO = { KV: 'XK' }
const normalizeCountryCode = cc => (cc ? NON_ISO[cc] || cc : null)

// Where the familiar English name differs from CLDR's current preference. Kept short on
// purpose: only entries whose CLDR form would plausibly break an exact-match lookup.
const CONVENTIONAL = {
  TR: 'Turkey',
  CZ: 'Czech Republic',
  HK: 'Hong Kong',
  MO: 'Macao',
  CD: 'Democratic Republic of the Congo',
  CG: 'Republic of the Congo',
  MM: 'Myanmar',
  CV: 'Cape Verde',
  SZ: 'Eswatini',
  TL: 'Timor-Leste'
}

// Extra strings a query might use that are not derivable from either name above.
const EXTRA_ALIASES = {
  GB: ['UK', 'Great Britain', 'Britain', 'England'],
  US: ['USA', 'United States of America'],
  RU: ['Russian Federation'],
  KR: ['Republic of Korea', 'South Korea'],
  KP: ['North Korea', "Democratic People's Republic of Korea"],
  IR: ['Islamic Republic of Iran', 'Persia'],
  SY: ['Syrian Arab Republic'],
  LA: ["Lao People's Democratic Republic"],
  VN: ['Viet Nam'],
  TZ: ['United Republic of Tanzania'],
  BO: ['Plurinational State of Bolivia'],
  VE: ['Bolivarian Republic of Venezuela'],
  MD: ['Republic of Moldova'],
  MK: ['Macedonia', 'FYROM'],
  SZ: ['Swaziland'],
  TL: ['East Timor'],
  CV: ['Cabo Verde'],
  MM: ['Burma'],
  CI: ['Ivory Coast'],
  NL: ['Holland', 'The Netherlands'],
  CD: ['DR Congo', 'DRC', 'Congo-Kinshasa', 'Zaire'],
  CG: ['Congo-Brazzaville'],
  MO: ['Macau'],
  AE: ['UAE'],
  VA: ['Vatican City'],
  XK: ['Republic of Kosovo']
}

// NFD splits a precomposed letter into base + combining mark, so dropping the marks
// folds ü to u and ç to c. Also normalises CLDR's typographic apostrophe.
const asciiFold = s => s
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[‘’]/g, "'")

// CLDR's abbreviations expanded back to the forms people write.
const expand = s => s
  .replace(/ SAR China$/, '')
  .replace(/\bSt\./g, 'Saint')
  .replace(/ & /g, ' and ')
  .replace(/^(.*) - (.*)$/, '$1-$2')

const cldrName = cc => {
  if (!cc) return null
  try {
    const n = regionNames.of(cc)
    return n === cc ? null : n
  } catch { return null }
}

// The conventional ASCII name: an explicit override if there is one, otherwise CLDR
// with its abbreviations expanded and diacritics folded away.
function conventionalName (cc) {
  if (!cc) return null
  if (CONVENTIONAL[cc]) return CONVENTIONAL[cc]
  const cldr = cldrName(cc)
  return cldr ? asciiFold(expand(cldr)) : null
}

// Everything worth matching this country on, most canonical first.
function aliases (cc) {
  const cldr = cldrName(cc)
  const out = [conventionalName(cc), cldr, cldr && expand(cldr), cldr && asciiFold(cldr),
    ...(EXTRA_ALIASES[cc] || [])]
  return [...new Set(out.filter(Boolean))]
}

// A lookup table for the countries actually present, emitted once in the JSON envelope
// rather than repeated on all 9159 rows.
function countryTable (codes) {
  const table = {}
  for (const cc of [...new Set(codes)].filter(Boolean).sort()) {
    const name = conventionalName(cc)
    if (!name) continue
    const entry = { name, aliases: aliases(cc) }
    const cldr = cldrName(cc)
    if (cldr && cldr !== name) entry.cldr = cldr
    table[cc] = entry
  }
  return table
}

module.exports = { conventionalName, cldrName, aliases, countryTable, normalizeCountryCode }
