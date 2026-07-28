# Eurocontrol Atlas TopoJSON

This repository provides a convenient mechanism for generating TopoJSON files for Eurocontrol region

## Installing

Before you can make anything, you’ll need Node.js and GDAL.

On Mac OS X, via [Homebrew](http://mxcl.github.com/homebrew/):

```bash
brew install node gdal
```

On GNU/Linux, from your distribution’s packages — for example on Arch:

```bash
sudo pacman -S nodejs npm gdal
```

The Makefile handles the tool differences between the two platforms itself: it picks
`gsed` or `sed` for GNU sed, and `md5 -qs` or `md5sum` for string hashing. GNU Make 4.4
or newer is fine.

Then, clone this repository and install its dependencies:

```bash
git clone https://github.com/Overwatch-AI/eurocontrol-atlas.git
cd eurocontrol-atlas
npm install
```

## Make Targets

Once you have everything installed, you can make various targets defined in the Makefile.


```bash
make help
```


## ICAO code datasets

Two targets build tabular ICAO code references, independently of the TopoJSON map
outputs. Both need `ogr2ogr` (GDAL), Node and `curl`; nothing else.

### `make icao-codes` — every ICAO code with a city and country

```bash
make icao-codes
# -> data/icao-codes.json
# -> data/icao-codes.csv
```

One row per ICAO code, covering **both** airspace regions and aerodromes — 9159 codes:
8837 `AIRPORT`, 255 `FIR`, 63 `UIR`, 4 `OTHER`. Regions come from the EUROCONTROL
PRISME `[FU]IR` export; aerodromes and all city/country resolution come from the
[NOAA AWC station cache](https://aviationweather.gov/data/api/#cache).

A region and an aerodrome resolve through the same lookup, and agree on the city:

```bash
$ jq -c '.entries[] | select(.code=="LFFF" and .type=="FIR")
         | {code,type,city,country_name,fab,min_fl,max_fl,airspace_id}' data/icao-codes.json
{"code":"LFFF","type":"FIR","city":"Paris","country_name":"France","fab":"fabec","min_fl":0,"max_fl":195,"airspace_id":"LFFFFIR"}

$ jq -c '.entries[] | select(.code=="LFPG")
         | {code,type,city,country,country_name,iata,state_code}' data/icao-codes.json
{"code":"LFPG","type":"AIRPORT","city":"Paris","country":"FR","country_name":"France","iata":"CDG","state_code":"ID"}
```

### `code` is the ICAO indicator; `type` carries FIR vs UIR

`code` is always a bare ICAO location indicator — Damascus FIR is `OSTT`, not `OSTTFIR`.
EUROCONTROL's own airspace identifier glues the airspace class onto the indicator, and
that form is kept in `airspace_id` for tracing a row back to the NM data.

**`code` alone is not a unique key.** An indicator commonly carries both an FIR and a
UIR, and 31 indicators also name an aerodrome — `HSSS` is both Khartoum airport and the
Khartoum FIC. The key is `(code, type, subarea)`; the build fails loudly if that ever
collides.

```bash
$ jq -c '.entries[] | select(.code=="EGTT") | {code,type,name,min_fl,max_fl}' \
    data/icao-codes.json
{"code":"EGTT","type":"FIR","name":"LONDON FIR","min_fl":0,"max_fl":245}
{"code":"EGTT","type":"UIR","name":"LONDON UIR","min_fl":245,"max_fl":999}
```

`subarea` is the trailing sub-area letter where the source splits a region — the north
and south halves of the Canarias UIR are `GCCC`/`UIR`/`N` and `GCCC`/`UIR`/`S`. It is
null for the other 316 regions and for every aerodrome.

Every aerodrome under a given country, using the ISO 3166-1 alpha-2 code:

```bash
$ jq -r '[.entries[] | select(.type=="AIRPORT" and .country=="IS") | .code] | join(" ")' \
    data/icao-codes.json
BIAR BIBD BIEG BIGJ BIGR BIHN BIHU BIIS BIKF BIRG BIRK BIST BITN BIVM BIVO
```

`city_source` records where each city came from, so you can restrict yourself to the
strongest provenance:

```bash
$ jq '[.entries[] | select(.city_source=="site-city")] | length' data/icao-codes.json
2433
```

Three things to know before joining against this:

* **`state_code` is not ISO 3166-2.** It is passed through verbatim from the station
  cache, where it is a two-character AWC/NWS code that only coincides with ISO for the
  US and Canada. `country` *is* ISO 3166-1 alpha-2 and can be joined as such.
* **Resolve countries through `countries[<iso2>].aliases`, not by matching
  `country_name`.** See below.
* City coverage is 99% for aerodromes and 97% for regions, but a `city_source` of
  `site-name` or `region-name` means the value was derived rather than corroborated.

### Country names are conventional ASCII, with an alias table

`country_name` is the familiar English form — `Turkey`, `Czech Republic`, `Hong Kong`,
`Cote d'Ivoire` — rather than what `Intl.DisplayNames(['en'])` returns, which is
`Türkiye`, `Czechia`, `Hong Kong SAR China`, `Côte d’Ivoire`. Those CLDR forms are
correct English, but a consumer that generates an exact-match filter gets an empty
result that looks like real absence rather than a spelling mismatch. Nothing is lost:
the JSON envelope carries a `countries` table with the CLDR name and every alias worth
matching, once, rather than on all 9159 rows.

```bash
$ jq -c '.countries.TR' data/icao-codes.json
{"name":"Turkey","aliases":["Turkey","Türkiye","Turkiye"],"cldr":"Türkiye"}
```

So to answer "which regions cover Turkey?" from arbitrary phrasing, resolve the country
code first, then filter rows on `country`:

```bash
$ jq -r --arg q 'Türkiye' '
    (.countries | to_entries[] | select(.value.aliases | any(ascii_downcase == ($q|ascii_downcase))) | .key) as $cc
    | [.entries[] | select(.country==$cc and .type!="AIRPORT") | .code] | join(" ")' data/icao-codes.json
LTAA LTBB
```

`Turkey`, `Türkiye`, `Czech Republic`, `Czechia`, `Hong Kong`, `Ivory Coast`, `Burma`,
`UK`, `Macedonia` and `Swaziland` all resolve this way. `bin/countries.js` holds the
rules and is shared with `firs-all`, so the two datasets cannot disagree.

`data/README.md` documents every column, the resolution strategy and the known gaps.

### `make firs-all` — regions only, plus a reconciliation

```bash
make firs-all
# -> data/firs-all.csv, data/firs-all.json
# -> data/firs-diff.csv
```

All 322 regions of the current AIRAC cycle with no FAB or Eurocontrol filter applied,
carrying flight levels, Eurocontrol membership and FAB. Unlike `data/firs.tsv`, which is
filtered to the FAB member states, this is the complete set.

```bash
$ awk -F, 'NR==1 || ($2=="UIR" && $10=="fabec")' data/firs-all.csv | cut -d, -f1,4,11,12
code,name,min_fl,max_fl
EBUR,BRUSSELS UIR,195,999
EDUU,RHEIN UIR,245,999
EDVV,HANNOVER UIR,245,999
LFFF,FRANCE UIR,195,999
LSAS,SWITZERLAND UIR,195,999
```

`data/firs-diff.csv` reconciles the current cycle against the 2015 snapshot still held in
`zip/FirUir_NM.zip`, which is useful for spotting real airspace changes. It joins the two
cycles on `airspace_id`, since that is the only field identifying a single airspace across
cycles — `LECB` alone would conflate the FIR with the UIR:

```bash
$ awk -F, 'NR==1 || $4=="LE"' data/firs-diff.csv
change,airspace_id,code,icao_state,detail
fl-changed,LECBFIR,LECB,LE,0-245 -> 0-195
fl-changed,LECBUIR,LECB,LE,245-999 -> 195-999
fl-changed,LECMFIR,LECM,LE,0-245 -> 0-195
fl-changed,LECMUIR,LECM,LE,245-999 -> 195-999
removed,GCCCUIR,GCCC,LE,CANARIS UIR
```

### Getting the source GIS data (`shp/`, `geojson/`)

Both directories are gitignored build inputs, so a **fresh clone has the committed
outputs under `data/` but neither of them**. Fetch and unpack them without regenerating
anything:

```bash
make sources
```

| file | features | where it comes from |
| --- | --- | --- |
| `geojson/ir-524.geojson` | 336 | downloaded from `euctrl-pru/pruatlas` (pinned commit) — the current [FU]IR polygons |
| `geojson/stations.json` | 9872 | downloaded from NOAA AWC, gunzipped — the station cache |
| `shp/euctrl/firs_unfiltered.shp` | 151 | unpacked from the committed `zip/FirUir_NM.zip`, no network — the 2015 snapshot |
| `shp/ses/firs.shp` | 69 | `ogr2ogr` filter of the above to the FAB member states |

All are readable straight from GDAL/QGIS. The other `shp/` layers come from their own
targets: `make shp/euctrl/firs.shp` for the Eurocontrol-member cut, and
`make shp/ne_50m_admin_0_countries.shp` for Natural Earth (downloads a zip first).

> `make sources` exists because the Makefile declares a bare `.SECONDARY:`, which marks
> every target secondary. Make then treats a *missing* intermediate as acceptable while
> the final output is up to date — so on a fresh clone `make icao-codes` reports
> "up to date" and downloads nothing at all. Naming the inputs as goals avoids that.
> Removing `.SECONDARY:` is not the fix: it is what stops make deleting these same
> intermediates after a build.

### Refreshing the sources

`zip/FirUir_NM.zip` is a manual export from 2015-12-08 (CFMU AIRAC cycle 406) and has no
refresh rule. The current region set is instead downloaded from
[euctrl-pru/pruatlas](https://github.com/euctrl-pru/pruatlas), which publishes newer
cycles of the same PRISME export, pinned to a commit so builds are reproducible:

```make
AIRAC_CURRENT = 524
PRUATLAS_SHA  = 0927219fec659e28913a325c7473c38239675003
```

Bump both when a newer `ir-<cycle>.geojson` appears upstream. The station cache is
refreshed daily by NOAA and is cached locally under `geojson/`, so pull a fresh copy
with:

```bash
rm geojson/stations.json && make icao-codes
```

Both targets are incremental and will do nothing while their outputs are newer than
their inputs — which is what a checkout leaves you with, since git gives the committed
files current mtimes. `make -B <target>` forces a full rebuild, re-downloading both
remote sources; to regenerate from the already-downloaded inputs without touching the
network, delete the outputs under `data/` and re-run instead.


## FABs

Each FAB has been assigned a unique ID, see `data/fab-id-name.csv`. This is the file that can
be used for example in `D3` to associate the id to the name.


## Getting all relevant flight levels (FLs) for a set of FIRs

Given all the FIRs for Eurocontrol as from `euctrl` target, the following jq
filter will return the list of unique FLs, i.e. the slices to consider when
merging the relevant set of FIRs:

```bash
$ jq "[.objects.firs.geometries| .[].properties | .minfl , .maxfl] | unique" firs.json
[
  0,
  195,
  245,
  275,
  285,
  999
]
```

Select all the FIRs whose `minfl` is equal to 285:

```bash
$ jq ".objects.firs.geometries| .[].properties | select(.minfl|  . == 285)" firs.json
{
  "id": "EFINUIR",
  "icao": "EF",
  "name": "FINLAND UIR",
  "minfl": 285,
  "maxfl": 999
}
{
  "id": "LYBAUIR",
  "icao": "LY",
  "name": "BEOGRAD UIR",
  "minfl": 285,
  "maxfl": 999
}
```

The FIRs that exist at FL245 are (these are the ones to be merged when
considering State or Fab aggregation):

```bash
$ jq ".objects.firs.geometries| .[].properties | select(. | .minfl <= 245 and .maxfl > 245) | .id" firs.json
"LJLAFIR"
"EISNUIR"
"LFFFUIR"
"LZBBFIR"
"LHCCFIR"
"LTBBFIR"
"EETTFIR"
"ENORFIR"
"EPWWFIR"
"LPPOFIR"
"UDDDFIR"
"EHAAFIR"
"EKDKFIR"
"LIRRUIR"
"UKLVFIR"
"LOVVFIR"
"EDVVUIR"
"LUUUFIR"
"LDZOFIR"
"LIMMUIR"
"LAAAFIR"
"UKFVFIR"
"EBURUIR"
"EFINFIR"
"LYBAFIR"
"ESAAFIR"
"EGGXFIR"
"ENOBFIR"
"EGPXUIR"
"LECBUIR"
"LMMMUIR"
"LCCCUIR"
"LTAAFIR"
"LPPCFIR"
"GCCCUIR"
"LBSRFIR"
"EGTTUIR"
"LWSSFIR"
"UGGGUIR"
"LKAAFIR"
"LQSBUIR"
"LSASUIR"
"LECMUIR"
"LRBBFIR"
"UKDVFIR"
"LIBBUIR"
"EYVLUIR"
"EVRRFIR"
"UKBVFIR"
"EDUUUIR"
"LGGGUIR"
"UKOVFIR"
```
