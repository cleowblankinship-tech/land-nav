# Land Nav

A land-navigation practice app. The course setter generates points inside an area; the
navigator plots them on a paper map, walks to them with map/protractor/compass, and the
phone's GPS only *confirms* a find. Static site, no backend, no accounts. Works offline.

## Pages

| Page | Who | What |
|---|---|---|
| `setup.html` | course setter | boundary (OSM/Overpass or hand-drawn), start point, point generation, lane card, share link, printable MGRS-grid map |
| `card.html#…` | navigator | printable lane card (no map): start + P1–Pn MGRS, IDs, time limit |
| `run.html#…` | navigator | plan → clock → check-ins (no map, no position) → results + reveal map |
| `score.html` | either | score a GPX file (Strava/Garmin) against a course |

## How check-in works

Tap **Check in**: the phone collects GPS fixes for ~8–15 s, averages them (inverse-variance
weighted, outliers dropped) and compares to every point not yet found.
Within the radius → FOUND. Otherwise → "No point here" (never distance or direction).
If accuracy is worse than the radius the app says so; a poor-accuracy *miss* is logged as
inconclusive rather than a miss.

## Develop

```sh
npm install
npm test          # unit tests (MGRS, distance, generator, OSM parsing, check-in, GPX, SW manifest)
npm run serve     # http://localhost:8080  (localhost is a secure context, so GPS works)
npm run vendor    # re-copy leaflet / mgrs / proj4 from node_modules into vendor/
```

`vendor/` is committed on purpose so the deployed site needs no build step and no CDN.

## Deploy to GitHub Pages

1. Merge this work into `main` (the workflow deploys on pushes to `main`).
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The repo must be **public** on a free GitHub plan (private-repo Pages needs a paid plan).
4. Push/merge to `main` (or **Actions → Test and deploy → Run workflow**). The site appears at
   `https://<user>.github.io/land-nav/`.
5. On the phone, open the site over HTTPS, then *Share → Add to Home Screen* (iOS) or
   *⋮ → Install app* (Android). Open it once online so it can cache itself.

## Data & attribution

Boundaries, water, buildings, trails etc. come from OpenStreetMap via the Overpass API.
Elevation: terrain tiles hosted on AWS Open Data (Mapzen Terrain Tiles). Basemaps: OpenTopoMap, USGS The National Map, OpenStreetMap. These are fine for personal
practice use; don't hammer them. MGRS conversion uses the [`mgrs`](https://www.npmjs.com/package/mgrs)
package; the UTM grid overlay uses `proj4`; maps use Leaflet.

## Known limits

* OSM coverage varies. Points are checked against *mapped* water/buildings/cliffs/private
  land; unmapped hazards can still occur — eyeball the generated course on the topo map
  before handing it over.
* Slope filter (default: avoid > 25°) uses free AWS terrain tiles (Terrarium, ~7 m/px at zoom 14),
  which is good for steep hillsides but not for small rock bands or gullies. Each point's
  elevation and slope are shown in the point list.
* Phone browsers may throttle GPS in the background; the app holds a screen wake lock, but
  a watch/GPX backup is still the safety net.
* Course links are only lightly obfuscated (XOR + base64url in the `#` fragment).
