# Preflight Weather Briefing (Citation XLS+)

Upload a ForeFlight flight plan and get a route weather briefing built from live NWS/AWC data: a decoded and interpreted WPC surface analysis, terminal forecasts at ETD/ETA, en-route advisories, PIREPs and winds aloft, and a GO / GO WITH CAUTION / NO-GO screen tuned to the Cessna Citation XLS+.

> **Advisory only.** This is not an official FAA/NWS briefing and does not satisfy 14 CFR 91.103. Always obtain a standard briefing from an approved provider and comply with the AFM and your OpSpecs/SOPs. The pilot in command is the final authority.

## How it runs (free Firebase Spark plan)

Live site: **https://preflight-29da3.web.app**

- **Firebase Hosting** serves the page and a folder of weather files (`public/data/`).
- The **briefing engine runs in your browser** (`engine/lib`, bundled to `public/engine.js`).
- A **GitHub Action** (`.github/workflows/refresh-weather.yml`) refreshes every 10 minutes. It pulls the national METAR/TAF/PIREP caches, SIGMETs, G-AIRMETs, CWAs and WPC coded fronts with `scripts/snapshot.js`, then redeploys Hosting. GitHub's cron scheduler can skip runs for hours on new repositories, so each run loops every 10 minutes for about 5.5 hours and then starts the next run itself; the cron is only a backup.
- Winds aloft (GFS), model guidance (HRRR, NBM, GFS, ECMWF IFS, decoded from GRIB2 by Open-Meteo) and the chart images load live, straight from the browser.
- **Simulated radar:** HRRR simulated reflectivity (Iowa Environmental Mesonet tiles, 18 h past the latest run) stepped through the flight with the aircraft position, plus a strip of each model's estimated dBZ on the route at the time of passage (`engine/lib/simradar.js`, from model precipitation rate). It is page 3 of the PDF.
- **US fixes, navaids and procedures:** `scripts/procedures.js` writes every US fix and navaid from the FAA 28-day NASR data to `public/nav/<letter>.json` (about 71,500 names) along with the SIDs and STARs; route strings resolve against them, airways (`public/nav/airways.json`, 1,503 of them) are filled in between the fixes on each side, and a SID or STAR named in the route (for example `PTRON9.PSX`) is filled in with its fixes.
- **Fuel recommendation:** `engine/lib/fuel.js` takes the fuel plan from an uploaded ForeFlight briefing (or the XLS+ Flight Planning Guide tables in `engine/lib/perf.js` without one) and adds alternate, headwind and contingency fuel for what the brief found. Shown in the Fuel card and on page 3 of the PDF.
- **Briefing taxi diagrams:** the taxi diagrams printed in the ForeFlight briefing are cut out in the browser and shown in the NOTAM guide; the PDF uses them where no taxiway layout is on file.
- **2-page PDF brief:** after a run, the *2-page brief (PDF)* button downloads a letter-size brief (decision, surface sketch, terminals with alternate rules, factors, surface analysis led by "What it means for this flight", NOTAM closure diagrams, route/altitude options, NWP model forecasts, winds, raw reports).
- The page shows how old the weather data is. Over 20 minutes adds a caution, and over 45 minutes is a NO-GO until the data is refreshed.

### Setting up the refresh job

1. Push this repository to GitHub. A **public** repo gets unlimited Actions minutes. A private repo's free 2,000 minutes a month covers roughly a 20-30 minute refresh, so change the cron if you go private.
2. In the repo, go to **Settings → Secrets and variables → Actions → New repository secret**. Name it `FIREBASE_SERVICE_ACCOUNT` and paste the full JSON of a service-account key that has the **Firebase Hosting Admin** role.
3. Run the workflow once from the **Actions** tab (Run workflow). After that it runs on the schedule.
4. GitHub pauses scheduled workflows after 60 days with no repository activity. Re-enable it from the Actions tab if that happens.
5. Optional: in Firebase console → Hosting → Release history, set version retention to a few versions so old deploys don't pile up.

## Run it locally

Node.js 18 or newer: `npm start` builds the engine, pulls a snapshot and serves http://localhost:3000. `npm test` runs the unit tests.

## Getting the flight plan out of ForeFlight

In ForeFlight, open the route in **Maps** or **Flights**, tap **Share / Send to** and choose **Export .fpl (Garmin)**, **KML** or **GPX**, then drop the file on the page. You can also just type a route string (`KTEB SBJ SAWED ORL KPBI`); airways, SIDs/STARs and `DCT` are skipped and fixes are resolved through the AWC database.

The .fpl format carries no altitude or time, so set cruise altitude, ETD, TAS, alternate and Part 91/135 in the form.

## What it pulls

| Data | Source |
|---|---|
| METAR, TAF, PIREPs | aviationweather.gov Data API |
| SIGMETs, Convective SIGMETs, international SIGMETs | aviationweather.gov Data API |
| G-AIRMETs (ICE, TURB-HI/LO, LLWS, SFC_WND, IFR, MT_OBSC) | aviationweather.gov Data API |
| Center Weather Advisories | aviationweather.gov Data API |
| Airport runways and navaids | OurAirports (public domain), refreshed with the snapshot |
| Surface fronts and pressure centers, analysis + 12/24 h progs | WPC coded bulletins CODSUS / CODSRP (tgftp.nws.noaa.gov) |
| Surface analysis and forecast chart images | AWC / WPC |
| Winds, temperatures and freezing level aloft | NOAA GFS via Open-Meteo (the AWC FB wind tables were retired in 2026) |
| NOTAMs (optional) | FAA NOTAM API |

If a source fails, the briefing still runs, the failure is listed under **Data sources**, and the verdict becomes INCOMPLETE when core data (METAR, TAF, SIGMET, G-AIRMET) is missing.

## How the surface analysis is interpreted

1. The WPC coded analysis is decoded into fronts (cold, warm, stationary, occluded, troughs, dry lines) and highs/lows.
2. Each front is matched to its position on the 12-hour prog to get a motion vector (direction and speed).
3. The route is sampled every 10 nm with a climb/cruise/descent profile and timed with GFS winds, so every point has a time and altitude.
4. Each front is moved along its motion vector to the time you'll be at each point, to find where (and in which phase of flight) you meet it, and when it reaches the departure and destination airports.
5. Pressure centers within 600 nm are described, with movement and deepening/filling from the prog.
6. The narrative explains the weather to expect from each relevant boundary (frontal type, speed, cold-season icing cues, terminal air masses) and what it means for this flight.

## Model guidance (NWP)

HRRR, NBM, GFS and ECMWF IFS point forecasts for the departure, destination and alternate windows: flight category from model visibility and an estimated cloud base (temperature/dew point spread where the model has low cloud), weather type, gusts, CAPE/lifted index and freezing level. The brief flags where two or more models are worse than the TAF, show freezing precipitation or thunderstorms the TAF lacks, or disagree widely. GFS pressure-level temperature and humidity also screen the route for icing-potential layers.

## Route and altitude options

Lateral offsets of the direct course (60, 120 and 180 nm each side, through two turn points snapped to nearby VORs) are scored for exposure to SIGMETs, Convective SIGMETs, CWAs, G-AIRMET icing/turbulence at altitude and time, severe/moderate PIREPs and thunderstorm METARs, plus the extra time. Cruise levels FL310-FL450 are compared on the filed route for wind component, ISA deviation, trip fuel from the XLS+ Flight Planning Guide tables and advisories at each level.

## Go/no-go logic (XLS+ defaults, all adjustable in the form)

**NO-GO** items (any one stops the flight as planned):
- Destination forecast below approach minimums at ETA ±1 h (default 200 ft / ½ SM); 135.219 under Part 135
- Alternate required but none filed. Part 91: 91.169 (2,000 ft and 3 SM, ETA ±1 h). Part 135: 135.223(b) — ceiling 1,500 ft above the lowest circling MDA (or, if circling is not authorized, 1,500 ft above the lowest published minimum or 2,000 ft above the airport, whichever is higher) and visibility 3 SM or 2 SM above the lowest visibility minimum, whichever is greater, from 1 hour before to 1 hour after ETA. Enter chart figures in the form; blank fields use Category C estimates.
- Alternate below its weather minimums: Part 135 uses standard OpSpec C055 derived minimums (+400 ft/+1 SM with one navigation facility, +200 ft/+½ SM with two), Part 91 uses 600-2 / 800-2. A high-minimums PIC option adds 100 ft and ½ SM (135.225).
- Crosswind above 25 kt (max demonstrated) or tailwind above 10 kt on the best runway, using gusts
- Freezing rain/drizzle at departure or destination
- Thunderstorms in the prevailing TAF at departure/destination, or a Convective SIGMET over the climb/descent
- Severe icing or severe turbulence SIGMETs or PIREPs on the route at your altitude; volcanic ash
- Equivalent still-air distance (route + alternate, wind-corrected) beyond ~1,850 nm
- Missing destination weather under Part 135

**CAUTION** items: Convective SIGMETs at cruise (with tops vs FL), G-AIRMET moderate icing (FIKI, minimize exposure), moderate turbulence, LLWS, gust spread, fronts crossing the route or reaching the destination near ETA, jet cores of 120 kt or more and vertical shear, TEMPO/PROB conditions below minimums, runway shorter than 5,000 ft.

The XLS+ figures (FL450 ceiling, ~430 KTAS, 25 kt demonstrated crosswind, ~1,850 nm NBAA range, FIKI) are representative published values for screening only. Check them against your AFM and company data.

## Layout

```
firebase.json                       Hosting config
.firebaserc                         Firebase project (preflight-29da3)
.github/workflows/refresh-weather.yml  10-minute refresh + Hosting deploy
scripts/snapshot.js                 pulls national weather data into public/data/
engine/lib/browser.js               browser entry point (bundled to public/engine.js)
engine/lib/parse.js                 .fpl / KML / GPX / route-string parsers
engine/lib/wx.js                    data access (snapshot files, or live APIs on a server)
engine/lib/fronts.js                WPC coded bulletin decoder and route-relative front analysis
engine/lib/decode.js                METAR/TAF helpers (ceiling, visibility, TAF windows)
engine/lib/brief.js                 route timing, hazard screening, go/no-go, surface narrative
engine/lib/aircraft.js              Citation XLS+ profile
engine/handler.js, server.js        optional local server (also a live-API mode)
public/                             web UI served by Firebase Hosting (Leaflet map)
samples/           sample ForeFlight .fpl
test/              unit tests
```

## Approach minimums

`scripts/minimums.js` reads the landing minimums block of every FAA d-TPP approach chart (and the FAA Alternate
Minimums pages) for airports with a hard runway of 4,000 ft or more and writes `public/minimums/<ID>.json`. The
`Approach minimums` workflow rebuilds them when a new 28-day chart cycle starts. The engine uses them for the
135.223(b) test at the destination and the OpSpec C055 alternate minimums; figures entered in the form override
them. Values are parsed from chart PDFs, so always confirm against the current chart.

## NOTAM closure guide

Drop a ForeFlight briefing PDF (or paste NOTAM text) into the form. The PDF is read in the browser with pdf.js
and never uploaded. `engine/lib/notam.js` picks out runway, taxiway and apron closures; closed runways and
out-of-service approach aids are removed from the runway, crosswind and approach-minimums checks.
`public/notam.js` draws them on a diagram from `public/layout/<ID>.json` (runway and taxiway shapes from
OpenStreetMap, built by the `Airport layouts` workflow), falling back to a live OpenStreetMap query and then to
a runway-only sketch. Layout data © OpenStreetMap contributors (ODbL).

## SIDs, STARs and approaches

`scripts/procedures.js` builds `public/procedures/<FAA id>.json` from the FAA NASR 28-day subscription (DP, STAR,
FIX and NAV CSV files); it runs in the `Approach minimums` workflow each cycle. `engine/lib/procedures.js` picks
the SID and STAR that serve the wind-favored runway (minus NOTAM-closed runways), stay closest to the route and
cross the least weather, and names the lowest-minimums approach to the landing runway against the forecast.
ATC assigns the real procedures; this is a planning suggestion.
