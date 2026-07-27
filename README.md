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
$ jq -c '.entries[] | select(.code=="LFFFFIR")
         | {code,type,city,country,country_name,fab,min_fl,max_fl}' data/icao-codes.json
{"code":"LFFFFIR","type":"FIR","city":"Paris","country":"FR","country_name":"France","fab":"fabec","min_fl":0,"max_fl":195}

$ jq -c '.entries[] | select(.code=="LFPG")
         | {code,type,city,country,country_name,iata,state_code}' data/icao-codes.json
{"code":"LFPG","type":"AIRPORT","city":"Paris","country":"FR","country_name":"France","iata":"CDG","state_code":"ID"}
```

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

Two things to know before joining against this:

* **`state_code` is not ISO 3166-2.** It is passed through verbatim from the station
  cache, where it is a two-character AWC/NWS code that only coincides with ISO for the
  US and Canada. `country` *is* ISO 3166-1 alpha-2 and can be joined as such.
* City coverage is 99% for aerodromes and 97% for regions, but a `city_source` of
  `site-name` or `region-name` means the value was derived rather than corroborated.

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
$ awk -F, 'NR==1 || ($3=="UIR" && $9=="fabec")' data/firs-all.csv | cut -d, -f1,2,10,11
code,name,min_fl,max_fl
EBURUIR,BRUSSELS UIR,195,999
EDUUUIR,RHEIN UIR,245,999
EDVVUIR,HANNOVER UIR,245,999
LFFFUIR,FRANCE UIR,195,999
LSASUIR,SWITZERLAND UIR,195,999
```

`data/firs-diff.csv` reconciles the current cycle against the 2015 snapshot still held in
`zip/FirUir_NM.zip`, which is useful for spotting real airspace changes:

```bash
$ awk -F, 'NR==1 || $3=="LE"' data/firs-diff.csv
change,code,icao_state,detail
fl-changed,LECBFIR,LE,0-245 -> 0-195
fl-changed,LECBUIR,LE,245-999 -> 195-999
fl-changed,LECMFIR,LE,0-245 -> 0-195
fl-changed,LECMUIR,LE,245-999 -> 195-999
removed,GCCCUIR,LE,CANARIS UIR
```

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
refreshed daily by NOAA and is cached locally, so pull a fresh copy with:

```bash
rm geojson/stations.json && make icao-codes
```


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
