Note: Kosovo has been assigned numeric code 900

The file `world-country-names.tsv` comes from [Mike Bostock](https://gist.github.com/mbostock/4090846) and has been modified for Kosovo.

## `icao-codes.json` / `icao-codes.csv` — unified ICAO code lookup

One row per ICAO code covering **both** the [FU]IRs of the current AIRAC cycle and
every aerodrome/station in the NOAA AWC station cache, each with a city and country.
Built by `make icao-codes`. 9159 codes: 8837 `AIRPORT`, 255 `FIR`, 63 `UIR`, 4 `OTHER`.

Sources: `ir-<cycle>.geojson` (see below) for the regions, and the
[AWC station cache](https://aviationweather.gov/data/api/#cache)
(`stations.cache.json.gz`, refreshed daily) for the aerodromes and for all city/country
resolution. Delete `geojson/stations.json` to pull a fresh cache.

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
The key is `(code, type, subarea)`, verified unique at build time; the build aborts
rather than emit a file whose rows silently collide.

Note the decomposition applies only to regions, never to aerodrome codes: `KFIR` is a
real US station ("First Divide") and stays `KFIR`, where a blanket suffix strip would
have reduced it to `K`.

### Country naming: match on `country`, not `country_name`

`country` in the station cache **is** ISO 3166-1 alpha-2 and is the intended join key.
The one exception is folded on the way in: AWC uses the non-ISO `KV` for Kosovo, which
becomes `XK`, the user-assigned ISO code `eurocontrol.csv` already carries. After that
every row with a country has a name — 237 countries are in use.

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

That table is emitted once in the JSON envelope rather than repeated on all 9159 rows
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
| `site-city` | 2433 | `site` is `"City/Aerodrome Name"`; city is the part before `/` |
| `site-name` | 6273 | bare `site`, with aerodrome words (`Arpt`, `Muni`, `Intl`, `AFB`, …) stripped off the tail |
| `station` | 213 | region name confirmed against a station place name in the same country |
| `region-name` | 100 | region name only, no station corroborated it |

`site-name` yields the station's *place*, which is usually but not always a city —
`Cheyenne Mountain` and `Fourchu Head` come through as-is. Filter on `city_source` if
you need only the corroborated ones.

[FU]IR codes are ICAO location indicators, so a region shares its prefix with the
stations beneath it (`LFFFFIR` and `LFPG` are both `LF`). Country is resolved by
longest-prefix majority vote over station indicators, 4 → 3 → 2 characters, because two
characters is not always decisive: `UT` spans Turkmenistan, Tajikistan *and* Uzbekistan.
`country_prefix` records how many characters actually matched.

Coverage: regions 319/322 country, 313/322 city; airports 8703/8837 country,
8706/8837 city. What is left over is genuinely unresolvable — `BODO`/`XXXX` and the
`EGGX`/`LPPO` rerouting extensions are not real regions, `D REGION` and
`V W A REGION` are placeholder names, `KAZACHSTAN MERGED FI` is truncated upstream,
and `ENORFIR`/`ULLLFIR`/`URRVFIR` have a `null` name in cycle 524 (cycle 406 had
`SANKT-PETERBURG` and `ROSTOV` for the latter two, if you want a fallback).
The 131 airports without a city have a `site` of literally `MIL`.

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
