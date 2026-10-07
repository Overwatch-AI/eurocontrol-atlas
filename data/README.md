Note: Kosovo has been assigned numeric code 900

The file `world-country-names.tsv` comes from [Mike Bostock](https://gist.github.com/mbostock/4090846) and has been modified for Kosovo.

## `icao-codes.json` / `icao-codes.csv` — unified ICAO code lookup

Covers **both** the [FU]IRs of the current AIRAC cycle and every aerodrome/station in the
NOAA AWC station cache, topped up from OurAirports with the IATA codes and aerodromes the
cache lacks, each with a city and country. Built by `make icao-codes`.
12384 rows over 12279 distinct codes: 12062 `AIRPORT`, 255 `FIR`, 63 `UIR`, 4 `OTHER`.

Sources: `ir-<cycle>.geojson` (see below) for the regions, the
[AWC station cache](https://aviationweather.gov/data/api/#cache)
(`stations.cache.json.gz`, refreshed daily) for the aerodromes and for all region
city/country resolution, [OurAirports](https://ourairports.com/data/) `airports.csv`
(public domain, refreshed nightly) for IATA coverage — see
[the merge](#ourairports-the-iata-gap-in-the-station-cache) below — and the two curated
tables `iata-alt.csv` and `iata-owner.csv`. Delete `geojson/stations.json` or
`geojson/ourairports.csv` to pull a fresh copy.

### Identity: `code`, `type`, `subarea`, `airspace_id`

`code` is always a bare ICAO location indicator. EUROCONTROL's `[FU]IR` export does not
identify airspaces that way — it glues the airspace class, and sometimes a sub-area
letter, onto the indicator of the responsible FIC/ACC, so Damascus FIR arrives as
`OSTTFIR` and the halves of the Canarias UIR as `GCCCUIRN`/`GCCCUIRS`. That identifier is
decomposed on the way in:

| column | Damascus | Canarias UIR (north) | Paris CDG |
| --- | --- | --- | --- |
| `code` | `OSTT` | `GCCC` | `LFPG` |
| `type` | `FIR` | `UIR` | `AIRPORT` |
| `subarea` | *(null)* | `N` | *(null)* |
| `airspace_id` | `OSTTFIR` | `GCCCUIRN` | *(null)* |

`airspace_id` is retained so a row can be traced back to the NM data, and because it is
the only stable identifier for a single airspace *across* AIRAC cycles — which is what
`firs-diff.csv` joins on.

**`code` is deliberately not unique.** 60 indicators carry both an FIR and a UIR
(`EGTT` is London FIR *and* London UIR), and 31 also name an aerodrome — `HSSS` is both
Khartoum airport and the Khartoum FIC, `UAAA` both Almaty airport and the Almaty FIR.
The key is `(code, type, subarea, iata)`, verified unique at build time; the build aborts
rather than emit a file whose rows silently collide.

`iata` is in the key because an aerodrome can hold more than one live IATA *airport* code
and gets one row per code — see `iata-alt.csv` below. `counts` and `total` in the JSON
envelope are therefore row counts; count distinct `code` for aerodromes.

Note the decomposition applies only to regions, never to aerodrome codes: `KFIR` is a
real US station ("First Divide") and stays `KFIR`, where a blanket suffix strip would
have reduced it to `K`.

### Country naming: match on `country`, not `country_name`

`country` in the station cache **is** ISO 3166-1 alpha-2 and is the intended join key.
The one exception is folded on the way in: AWC uses the non-ISO `KV` for Kosovo, which
becomes `XK`, the user-assigned ISO code `eurocontrol.csv` already carries. After that
every row with a country has a name — 239 countries are in use.

`country_name` is the **conventional ASCII English** name, which is deliberately *not*
what `Intl.DisplayNames(['en'])` returns. CLDR tracks official renames and abbreviates,
so it gives `Türkiye`, `Czechia`, `Bosnia & Herzegovina`, `Hong Kong SAR China`. Those
are correct English, but anything that consumes this file by generating an exact-match
filter — an LLM being the obvious case — will reach for `Turkey` or `Hong Kong` and get
an empty result that looks like a legitimate "no such data" rather than a spelling
mismatch. So the rows carry the forgiving form, and nothing is lost:

```json
"countries": {
  "TR": { "name": "Turkey", "aliases": ["Turkey", "Türkiye", "Turkiye"], "cldr": "Türkiye" },
  "CI": { "name": "Cote d'Ivoire", "aliases": ["Cote d'Ivoire", "Côte d’Ivoire", "Ivory Coast"],
          "cldr": "Côte d’Ivoire" }
}
```

That table is emitted once in the JSON envelope rather than repeated on all 12384 rows
(≈14 kB total). **To resolve a country from arbitrary phrasing, match against
`countries[<iso2>].aliases` and then filter rows on `country`** — the aliases cover the
CLDR spelling, the ASCII fold, expanded abbreviations and common historical names, so
`Türkiye`, `Turkey`, `Czech Republic`, `Czechia`, `Hong Kong`, `Ivory Coast`, `Burma`,
`UK`, `Macedonia` and `Swaziland` all resolve. `bin/countries.js` holds the rules and is
shared with `firs-all`, so the two datasets cannot drift apart — `eurocontrol.csv`'s own
`name` column is no longer used for this, since it disagreed on Turkey, Czechia and
Bosnia & Herzegovina.

> **`state` is _not_ ISO 3166-2.** It is a two-character AWC/NWS subdivision code that
> only coincides with ISO for the US and Canada — 50% of stations — because ISO's codes
> there happen to be two characters too. Elsewhere it diverges: ISO 3166-2:GB is
> `ENG`/`SCT`/`WLS`/`NIR` where AWC gives `EN`/`SC`/`WL`/`NI`, ISO 3166-2:FR is
> `IDF`/`ARA`/`BFC`/… where AWC gives `ID`/`AR`/`BF`/…, and 207 country/state pairs are
> a *single* character, which no ISO 3166-2 subdivision ever is. It is carried through
> verbatim as `state_code` and deliberately not resolved or joined against ISO.

There is no city field anywhere in the cache — city exists only inside the `site`
string, so `city_source` records how each one was obtained:

| `city_source` | n | how |
| --- | --- | --- |
| `site-city` | 2437 | `site` is `"City/Aerodrome Name"`; city is the part before `/` |
| `site-name` | 6346 | bare `site`, with aerodrome words (`Arpt`, `Muni`, `Intl`, `AFB`, …) stripped off the tail |
| `station` | 217 | region name confirmed against a station place name in the same country |
| `region-name` | 96 | region name only, no station corroborated it |
| `ourairports` | 2859 | OurAirports `municipality`, verbatim; only on rows OurAirports added |

`site-name` yields the station's *place*, which is usually but not always a city —
`Cheyenne Mountain` and `Fourchu Head` come through as-is. Filter on `city_source` if
you need only the corroborated ones.

Both upstreams truncate long names in place, so a name can arrive with punctuation that
belongs to no place: an orphan bracket at the seam (`Culdrose )`, `Yeovilton Arpt)`,
`DAKAR TERRESTRE (PAR`) or the separator exposed once a trailing aerodrome/airspace word
is stripped (`Battle Mountain+ Arpt`, `MIAMI FIR / UIR`). Those edges are trimmed off
both `city` and the aerodrome `name`; a *balanced* bracket is content and is kept, so
`Fort Campbell Arpt(AAF)` stays whole as a name and still yields `Fort Campbell` as the
city. Trimming is edge-only — `N'Djamena`, `Port-au-Prince` and `Kiel/Holtenau` are
untouched. Region `name` stays verbatim from NM for traceability, punctuation and all.

[FU]IR codes are ICAO location indicators, so a region shares its prefix with the
stations beneath it (`LFFFFIR` and `LFPG` are both `LF`). Country is resolved by
longest-prefix majority vote over station indicators, 4 → 3 → 2 characters, because two
characters is not always decisive: `UT` spans Turkmenistan, Tajikistan *and* Uzbekistan.
`country_prefix` records how many characters actually matched.

Coverage: regions 319/322 country, 313/322 city; airport rows 11928/12062 country,
11642/12062 city. What is left over is genuinely unresolvable — `BODO`/`XXXX` and the
`EGGX`/`LPPO` rerouting extensions are not real regions, `D REGION` and
`V W A REGION` are placeholder names, `KAZACHSTAN MERGED FI` is truncated upstream,
and `ENORFIR`/`ULLLFIR`/`URRVFIR` have a `null` name in cycle 524 (cycle 406 had
`SANKT-PETERBURG` and `ROSTOV` for the latter two, if you want a fallback).
Of the airports without a city, 131 are stations whose `site` is literally `MIL`, and 289
are OurAirports rows with an empty `municipality`.

### OurAirports: the IATA gap in the station cache

The station cache only lists aerodromes that have a weather station, and only 5080 of its
8907 carry an IATA code, so a lookup built on it alone cannot resolve thousands of live
IATA codes. OurAirports `airports.csv` (public domain, 9051 IATA codes) closes most of that
gap. It **tops the cache up and never overrides it**: a station row keeps its name, city,
position and station fields. Each OurAirports airport with an IATA code is handled as
follows:

| outcome | n | what happens |
| --- | --- | --- |
| already known | 4929 | the cache row already has this code: nothing |
| filled | 138 | the cache row had no IATA code: it gets this one |
| second code | 6 | the cache row has a different code for the same field — a recode it has not caught up with (`LUKK` is `KIV` *and* the current `RMO`): a second row, the cache's code first, as an `iata-alt.csv` entry would |
| added | 3148 | not in the cache: a new row, `source: ourairports` |
| same field | 33 | the code already resolves to an aerodrome within 10 km under another indicator — a military/civil pair (`ETNU`/`EDBN`) or a renumbering: nothing is missing, so nothing is added |
| no ICAO | 781 | no four-letter indicator (FAA identifiers like `06U`, local codes): left out, so `code` stays an ICAO indicator |
| moved | 16 | the cache has this indicator more than 10 km from where OurAirports puts it (Indonesia renumbered its `WA..` indicators; some cache stations sit at 0,0): left out rather than resolve to the wrong place. The build lists them |

An aerodrome is recognised as already in the cache by OurAirports' `icao_code`, `ident`
or `gps_code`. `ident` is sometimes the *old* indicator (`LELO` for what is now `LERJ`), so
it is only used to recognise a row, never to name a new one: a new row takes `icao_code`,
or `gps_code` where that is blank and four letters (`BGAG`, `AYFE`).

Before and after, on the same station cache:

| | aerodromes | with an IATA code | distinct IATA codes | of OurAirports' 9051 |
| --- | --- | --- | --- | --- |
| station cache only | 8907 | 5080 | 5073 | 4989 |
| with OurAirports | 12055 | 8342 | 8341 | 8257 |

Rows from OurAirports have **no weather station behind them**: `site_types`,
`state_code` and AWC's `elev` are AWC-only, so `site_types` and `state_code` are null there
and `elev_m` is converted from OurAirports' feet. A row existing does not mean the
aerodrome has a METAR or TAF — test `site_types`, or `source: awc-station-cache`.
`state_code` is left null rather than filled from OurAirports' `iso_region`, which is real
ISO 3166-2 and so means something different (see above).

`iata_source` says where each row's `iata` came from: `awc-station-cache`, `ourairports`
or `iata-alt` (the curated table below), null where there is no code.

### `iata-owner.csv` — contested IATA codes (curated input)

An IATA code on two aerodromes is ambiguous to anyone resolving it, and OurAirports can
hand out a code the cache already gives to a different indicator. Neither upstream is
reliably the fresher one, so **the build fails on any such code OurAirports introduced
until it is settled here**, listing each one with both holders.

| column | meaning |
| --- | --- |
| `iata` | the contested code |
| `icao` | the indicator that owns it; more than one row if it is genuinely shared |
| `note` | the evidence, for review |

The code is then taken off every other holder; a holder left with no code keeps its row,
with `iata` null. The build also fails on an entry no upstream supports any more, so the
table cannot go stale silently. The 24 current entries are almost all a cache station
still filed under the old indicator of a recoded field (`FVHA` → `FVRG` for Harare,
`FLLS` → `FLKK` for Lusaka), plus a few airports that moved to a new field (`HTMB` →
`HTGW` Songwe, `SBNT` → `SBSG` Natal) and three cache errors (`AAD` on St Vincent rather
than Adado, `UKR` on Mokha rather than Mukeiras, and `SIP` on the Russian-assigned `URFF`
rather than ICAO's `UKFF`).

The ambiguity the cache brings with it is left alone and does not fail the build — see
the end of the next section.

### `iata-alt.csv` — alternate IATA airport codes (curated input)

The station cache carries exactly one `iataId` per station, but an aerodrome can hold more
than one live IATA *airport* code. `LFSB` is the case in point: EuroAirport is binational,
so it is `BSL` on the Swiss side and `MLH` on the French one, both current for booking and
billing. The cache gives `MLH`, which left `BSL` unfindable in the lookup.

| column | meaning |
| --- | --- |
| `icao` | the ICAO location indicator the codes belong to |
| `iata` | one IATA airport code |
| `rank` | emission order; `1` is the primary code |
| `note` | why this code exists, for review |

Each code becomes its own row in the output, `rank` first, which is why `iata` is part of
the key. A code the station cache knows but the table omits is appended rather than
dropped. `LFSB` is currently the only entry. The same one-row-per-code shape carries
OurAirports' second codes (above), so 7 aerodromes fan out to two rows in all.

Airport codes only. IATA **metropolitan area** codes are a separate namespace and are
many-to-one — `EAP` covers EuroAirport, but `NYC` covers eight New York aerodromes and
`LON` seven London ones — so they are deliberately absent rather than mixed into `iata`,
which would otherwise mean two different things depending on the row.

`iata` is not unique on its own either, from upstream: the station cache gives 8 codes to
two indicators each, usually an old and a new one for the same field (`SRG` as
`WAHS`/`WARS`, `TRK` as `WALR`/`WAQQ`, `PTZ` as `SEPA`/`SESM`, `GWD`, `ISU`, `CEM`, `GYA`,
`VTZ`). The merge adds none; a new one would fail the build until `iata-owner.csv` settles
it.

## `firs-all.csv` / `firs-all.json` — current [FU]IR reference list

Every Information Region of the current CFMU AIRAC cycle, with no FAB or
Eurocontrol filter applied. Built by `make firs-all`.

Columns: `code`, `name`, `type` (`FIR`/`UIR`/`OTHER`), `icao_state`, `country`,
`iso2`, `eurocontrol_member`, `eurocontrol_entry`, `fab`, `min_fl`, `max_fl`,
`airac_cfmu`, `source_features`.

**Source.** `zip/FirUir_NM.zip` in this repo is a manual PRISME export from
**2015-12-08** (CFMU AIRAC cycle 406) and there is no rule to refresh it.
EUROCONTROL PRU publish newer cycles of the same export openly in
[euctrl-pru/pruatlas](https://github.com/euctrl-pru/pruatlas) (`inst/extdata/ir-<cycle>.geojson`,
MIT per its `DESCRIPTION`), so `firs-all` downloads **cycle 524 (published 2025-03-13)**
from a pinned commit and uses that as the reference set. Bump `AIRAC_CURRENT` and
`PRUATLAS_SHA` in the `Makefile` when a newer cycle appears upstream.

Caveats worth knowing before relying on these files:

* `country`/`iso2`/`eurocontrol_entry` are joined on the ICAO state prefix via
  `eurocontrol.csv`, which only covers Eurocontrol member states — 239 of the 322
  regions are outside it and carry an empty `country`. The name itself is resolved from
  the ISO code through `bin/countries.js`, the same path `icao-codes.*` uses, so the two
  files always agree.
* Cycle 524 attributes some regions to a finer ICAO prefix than 406 did
  (e.g. Canarias moved `LE` → `GC`, Bodø `EN` → `BO`), which drops them out of the
  member-state and FAB joins.
* `code`, `type`, `subarea` and `airspace_id` mean exactly what they do in
  `icao-codes.*` above, decomposed from the same EUROCONTROL identifier.
* The source's own `airspace_type` field is the constant `"FIR"` for every feature,
  including the 63 identifiers ending in `UIR`, so `type` is derived from the
  identifier instead. `OTHER` covers the four entries that are not [FU]IRs at all:
  `BODO`, the `EGGX` and `LPPO` rerouting extensions, and the `XXXX` "no FIR west of
  Peru" placeholder.
* A handful of `name` values are truncated upstream (`KAZACHSTAN MERGED FI`).
* `source_features` > 1 marks regions the source splits by flight-level band; the
  export merges them into a single `min_fl`–`max_fl` range.

## `fir-uir.geojson` — the [FU]IR polygons

The geometry behind `firs-all.*`: 324 `MultiPolygon` features in CRS84, global, each with a
flight-level band. Built by `make fir-uir` from `geojson/ir-<cycle>.geojson`, which is
gitignored — so this is the only tracked copy of the shapes.

The filename carries no cycle, so a consumer's path survives an AIRAC bump. The cycle is
inside: as the FeatureCollection `name` (`ir-524`) and as `airac_cfmu` on every feature.

Properties: `airac_cfmu`, `airspace_id`, `code`, `type`, `subarea`, `name`, `icao_state`,
`id`, `min_fl`, `max_fl`. `code`, `type`, `subarea` and `airspace_id` mean exactly what they
do in `firs-all.*` and `icao-codes.*`, decomposed by the same `bin/airspace-id.js`, so the
three datasets cannot disagree.

```json
{"airac_cfmu":524,"airspace_id":"EGTTUIR","code":"EGTT","type":"UIR","subarea":null,
 "name":"LONDON UIR","icao_state":"EG","id":"1142035","min_fl":245,"max_fl":999}
```

Two ways this differs from the raw PRISME export it is built from:

* **`airspace_type` is dropped.** Upstream sets it to the constant `"FIR"` on every
  feature, including the ones whose identifier ends in `UIR`. Publishing it beside a
  correct `type` would put two disagreeing fields on the same feature, and its only use
  was as the field you must ignore. `type` replaces it.
* **12 repeated features are dropped**, leaving one shape per
  `(airspace_id, min_fl, max_fl)`. Upstream republishes a shape under an alternate name or
  NM object id — `GANDER NAT RVSM` / `GANDER FLIGHT INFORMATION REGION`, `NEW YORK FIR` /
  `NEW YORK OCEANIC`. The build fails loudly if two rows of one key ever carry different
  geometry, and keeps the first name, as `firs-export.js` does, so the two agree.

Those 324 features cover 322 identifiers: `GCCCUIRN` and `OBBBUIR` are each published as
two stacked bands, which is why `type` tallies 255 `FIR` / 65 `UIR` / 4 `OTHER` over
features but 255 / 63 / 4 over identifiers, matching `firs-all.*`.

`id` is the NM object id, kept for tracing a shape back into the source. It is not a key:
where a repeat was dropped it is the first of several, and it is not unique across
features.

Distinct identifiers do share a polygon, which is not a duplicate — a UIR is usually the
same footprint as its FIR at a higher band.

## `firs-diff.csv` — reconciliation against the 2015 snapshot

`change`,`airspace_id`,`code`,`icao_state`,`detail` — what moved between cycle 406 and
the current cycle. `change` is one of `added`, `removed`, `renamed`,
`renamed-truncated`, `fl-changed`, `state-changed`.

The two cycles are joined on `airspace_id`, not `code`: it is the only field that
identifies one airspace across cycles, where `LECB` would conflate the FIR with the UIR.
`code` is carried alongside for convenience.

Most of the 197 `added` / 24 `removed` rows are the 2015 model's coarse rest-of-world
placeholders (`KKKKFIR USA CONTINENTAL`, `ZYYYFIR CHINA+MONGOLIA`,
`UUUUFIR FICTICIOUS FIR REST OF RUSSIA`, …) being replaced by individual FIRs.
A region whose identifier changed shows up as a `removed`+`added` pair rather than a
rename (`BIRD` → `BIRDFIR`).
