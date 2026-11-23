# Preflight Weather Briefing (Citation XLS+)

Upload a ForeFlight flight plan and get a route weather briefing built from live NWS/AWC data: a decoded and interpreted WPC surface analysis, terminal forecasts at ETD/ETA, en-route advisories, PIREPs and winds aloft, and a GO / GO WITH CAUTION / NO-GO screen tuned to the Cessna Citation XLS+.

> **Advisory only.** This is not an official FAA/NWS briefing and does not satisfy 14 CFR 91.103. Always obtain a standard briefing from an approved provider and comply with the AFM and your OpSpecs/SOPs. The pilot in command is the final authority.

## Firebase (Hosting + Cloud Functions)

The web UI is served by **Firebase Hosting** from `public/`, and `/api/**` is rewritten to a 2nd-gen **Cloud Function** (`api`, Node 22, `us-central1`) in `functions/` that fetches the live weather and builds the briefing.

Requirements: a Firebase project on the **Blaze (pay-as-you-go) plan**. Cloud Functions, and their outbound calls to NWS/AWC, need Blaze. Normal use of this tool sits well inside the free tier.

```bash
npm install -g firebase-tools
firebase login
firebase use --add            # pick your project (replaces YOUR-FIREBASE-PROJECT-ID in .firebaserc)
cd functions && npm install && cd ..
firebase deploy               # deploys hosting + the api function
```

Your app is then at `https://<project-id>.web.app`.

Optional NOTAMs: get free credentials at https://api.faa.gov, then add them as function environment variables in `functions/.env` (not committed):

```
FAA_CLIENT_ID=...
FAA_CLIENT_SECRET=...
```

Local testing with the emulator: `firebase emulators:start --only functions,hosting` and open http://localhost:5000.

## Run it locally without Firebase

Requires Node.js 18 or newer, no install needed: `node server.js` and open http://localhost:3000 (`npm test` runs the unit tests). It uses the same handlers as the Cloud Function.

## Getting the flight plan out of ForeFlight

In ForeFlight, open the route in **Maps** or **Flights**, tap **Share / Send to** and choose **Export .fpl (Garmin)**, **KML** or **GPX**, then drop the file on the page. You can also just type a route string (`KTEB SBJ SAWED ORL KPBI`); airways, SIDs/STARs and `DCT` are skipped and fixes are resolved through the AWC database.

The .fpl format carries no altitude or time, so set cruise altitude, ETD, TAS, alternate and Part 91/135 in the form.

## What it pulls (live, on every run)

| Data | Source |
|---|---|
| METAR, TAF, PIREPs | aviationweather.gov Data API |
| SIGMETs, Convective SIGMETs, international SIGMETs | aviationweather.gov Data API |
| G-AIRMETs (ICE, TURB-HI/LO, LLWS, SFC_WND, IFR, MT_OBSC) | aviationweather.gov Data API |
| Center Weather Advisories | aviationweather.gov Data API |
| Airport runways, navaids and fixes | aviationweather.gov Data API |
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
firebase.json              Hosting config + /api/** rewrite to the function
.firebaserc                Firebase project alias (set yours)
functions/index.js         Cloud Function `api` (/api/brief, /api/chart, /api/health)
functions/handler.js       shared request handlers
functions/lib/parse.js     .fpl / KML / GPX / route-string parsers
functions/lib/wx.js        live data fetchers with caching
functions/lib/fronts.js    WPC coded bulletin decoder and route-relative front analysis
functions/lib/decode.js    METAR/TAF helpers (ceiling, visibility, TAF windows)
functions/lib/brief.js     route timing, hazard screening, go/no-go, surface narrative
functions/lib/aircraft.js  Citation XLS+ profile
public/                    web UI served by Firebase Hosting (Leaflet map)
server.js                  optional local dev server
samples/           sample ForeFlight .fpl
test/              unit tests
```
