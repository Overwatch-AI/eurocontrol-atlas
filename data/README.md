Note: Kosovo has been assigned numeric code 900

The file `world-country-names.tsv` comes from [Mike Bostock](https://gist.github.com/mbostock/4090846) and has been modified for Kosovo.

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
  regions are outside it and carry an empty `country`.
* Cycle 524 attributes some regions to a finer ICAO prefix than 406 did
  (e.g. Canarias moved `LE` → `GC`, Bodø `EN` → `BO`), which drops them out of the
  member-state and FAB joins.
* The source's own `airspace_type` field is the constant `"FIR"` for every feature,
  including the 63 codes ending in `UIR`, so `type` is derived from the code suffix
  instead. A trailing letter is a sub-area qualifier (`GCCCUIRN`/`GCCCUIRS`).
  `OTHER` covers the four entries that are not [FU]IRs at all: `BODO`, the `EGGX`
  and `LPPO` rerouting extensions, and the `XXXX` "no FIR west of Peru" placeholder.
* A handful of `name` values are truncated upstream (`KAZACHSTAN MERGED FI`).
* `source_features` > 1 marks regions the source splits by flight-level band; the
  export merges them into a single `min_fl`–`max_fl` range.

## `firs-diff.csv` — reconciliation against the 2015 snapshot

`change`,`code`,`icao_state`,`detail` — what moved between cycle 406 and the
current cycle. `change` is one of `added`, `removed`, `renamed`,
`renamed-truncated`, `fl-changed`, `state-changed`.

Most of the 197 `added` / 24 `removed` rows are the 2015 model's coarse rest-of-world
placeholders (`KKKKFIR USA CONTINENTAL`, `ZYYYFIR CHINA+MONGOLIA`,
`UUUUFIR FICTICIOUS FIR REST OF RUSSIA`, …) being replaced by individual FIRs.
Because the diff is keyed on `code`, a renumbered region shows up as a
`removed`+`added` pair rather than a rename (`BIRD` → `BIRDFIR`).
