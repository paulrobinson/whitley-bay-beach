# Beach Walk UK

> Know before you go — the best time to walk on the beach, for any UK bathing water location.


Live at: **[paulrobinson.github.io/beach-walk-uk](https://paulrobinson.github.io/beach-walk-uk/)**

---

## What it does

Beach Walk UK is a mobile-first, single-page web app that helps you decide the best time to head to the beach. For any of the **451 official UK Environment Agency bathing water locations**, it shows:

- **Best time to walk** — a recommended 2–3 hour window per day, scored on four factors: low tide (more exposed sand), weather, wind speed, and temperature.
- **Hourly weather strip** — temperature, wind speed, wind gusts, precipitation, and weather icon for each daylight hour.
- **Animated beach canvas** — a live-rendered tide visualisation showing how high or low the sea will be, with a day/night overlay and water temperature badge.
- **Tide height axis** — a labelled scale alongside the canvas showing tide height relative to the day's low water.
- **4-day forecast** — swipe between Today, Tomorrow, and the following two days.
- **"Right now" conditions** — always shows the current hour's weather at the top regardless of which day tab is selected.
- **Location picker** — searchable sheet with all 451 UK bathing water locations (coastal, river, and lake). Selection is persisted in `localStorage`.

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Vanilla JS (no framework — intentional for simplicity) |
| Bundler | [Vite](https://vitejs.dev/) v5 |
| Styling | Plain CSS (custom properties, no preprocessor needed) |
| Data | Static JSON (bathing water list) + live Open-Meteo API |
| Font | [Satoshi](https://fontshare.com/) via Fontshare CDN |
| Analytics | [Umami](https://umami.is/) (can be removed — see `index.html`) |
| Feedback | [Tally](https://tally.so/) embed widget |
| Hosting | GitHub Pages |

---

## Getting started

### Prerequisites

- Node.js 18+ and npm

### Install dependencies

```bash
npm install
```

### Run locally

```bash
npm run dev
```

Open [http://localhost:5173/beach-walk-uk/](http://localhost:5173/beach-walk-uk/) in your browser.

> **Note:** The app calls the [Open-Meteo](https://open-meteo.com/) public API directly from the browser. No API key is required for development — the free tier is used. If you see a rate-limit error, check [status.open-meteo.com](https://status.open-meteo.com/).

### Build for production

```bash
npm run build
```

The built output is written to `dist/`. This folder is what gets deployed to GitHub Pages.

### Preview the production build

```bash
npm run preview
```

---

## Project structure

```
beach-walk-uk/
├── index.html              # HTML template — markup only, no inline scripts
├── package.json
├── vite.config.js
├── .gitignore
├── data/
│   └── bathing-waters.json # 451 UK bathing water locations (static, from EA GeoJSON Aug 2025)
└── src/
    ├── main.js             # All application logic
    └── main.css            # All styles
```

---

## Data sources

### Bathing water locations (`data/bathing-waters.json`)

A static list of 451 UK bathing water locations from the Environment Agency's GeoJSON dataset (August 2025). Each entry has:

```json
{
  "name": "Whitley Bay",
  "lat": 55.0489,
  "lon": -1.4451,
  "type": "Coastal",
  "region": "North East"
}
```

Types are `Coastal`, `Transitional`, `River`, or `Lake`.

To refresh this list with the latest EA data, download the GeoJSON from [environment.data.gov.uk](https://environment.data.gov.uk/bwq/profiles/) and update the JSON file.

### Weather & marine data (live, Open-Meteo)

Two API calls are made on load and cached in memory for 30 minutes:

| API | Variables |
|---|---|
| `api.open-meteo.com/v1/forecast` | `temperature_2m`, `weather_code`, `wind_speed_10m`, `wind_gusts_10m`, `precipitation` |
| `marine-api.open-meteo.com/v1/marine` | `sea_level_height_msl`, `wave_height`, `sea_surface_temperature` |

Both requests use `timezone=Europe/London` and `forecast_days=4`.

---

## Best-time algorithm

Each daylight hour is scored out of 1.0 using four weighted factors:

| Factor | Weight | Logic |
|---|---|---|
| Low tide | 30% | `1 − (seaLevel − seaMin) / seaRange` — lower sea = more sand |
| Weather | 25% | Clear sky = 1.0, overcast = 0.55, heavy rain = 0.15, thunderstorm = 0.05 |
| Wind | 25% | `max(0, 1 − windMph / 35)` — 0 mph = 1.0, 35+ mph = 0.0 |
| Temperature | 20% | Peaks at 18°C, falls away either side |

The best contiguous 2–3 hour window (excluding dark hours) with the highest average score is highlighted. A 3-hour window gets a 3% bonus over a 2-hour window of equal average score.

---

## Deployment (GitHub Pages)

The live site is deployed by pushing the `dist/` folder contents to the `master` branch of [paulrobinson/beach-walk-uk](https://github.com/paulrobinson/beach-walk-uk), which has GitHub Pages enabled.

To redeploy after making changes:

```bash
npm run build
# Then push dist/ contents to the GitHub Pages branch
```

> **Note:** The `vite.config.js` sets `base: '/beach-walk-uk/'` to match the GitHub Pages subpath. If you move to a custom domain at the root, change `base` to `'/'`.

---

## Analytics & feedback

- **Umami analytics** — the `data-website-id` in `index.html` is tied to the live site. Remove the `<script>` tag or replace the ID for your own deployment.
- **Tally feedback** — the `data-tally-open="GxD4Zj"` form ID is the live form. Replace or remove for your deployment.

---

## License

No licence is currently specified. All rights reserved by the author unless stated otherwise.
