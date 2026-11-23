# Preflight Weather Briefing (Citation XLS+)

Upload a ForeFlight flight plan and get a route weather briefing built from live NWS/AWC data: a decoded and interpreted WPC surface analysis, terminal forecasts at ETD/ETA, en-route advisories, PIREPs and winds aloft, and a GO / GO WITH CAUTION / NO-GO screen tuned to the Cessna Citation XLS+.

> **Advisory only.** This is not an official FAA/NWS briefing and does not satisfy 14 CFR 91.103. Always obtain a standard briefing from an approved provider and comply with the AFM and your OpSpecs/SOPs. The pilot in command is the final authority.

## How it runs (free Firebase Spark plan)

Live site: **https://preflight-29da3.web.app**

- **Firebase Hosting** serves the page and a folder of weather files (`public/data/`).
- The **briefing engine runs in your browser** (`engine/lib`, bundled to `public/engine.js`).
- A **GitHub Action** (`.github/workflows/refresh-weather.yml`) runs every 10 minutes. It pulls the national METAR/TAF/PIREP caches, SIGMETs, G-AIRMETs, CWAs and WPC coded fronts with `scripts/snapshot.js`, then redeploys Hosting. GitHub can delay scheduled runs by a few minutes at busy times.
- Winds aloft (GFS via Open-Meteo) and the chart images load live, straight from the browser.
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

## Go/no-go logic (XLS+ defaults, all adjustable in the form)

**NO-GO** items (any one stops the flight as planned):
- Destination forecast below approach minimums at ETA ±1 h (default 200 ft / ½ SM); 135.219 under Part 135
- Alternate required (91.169 1-2-3 rule, or approximated 135.223) but none filed; alternate below 600-2
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
