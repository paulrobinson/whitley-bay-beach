#!/usr/bin/env python3
"""
fetch-uk-bathing-waters.py  —  Fetch bathing water locations for Wales and
Scotland and merge them into data/bathing-waters.json alongside the existing
England data.

Data sources
------------
  England  Environment Agency (EA) — data already present; gains country field.

  Wales    Natural Resources Wales (NRW) via the Defra Linked Data platform.
           https://environment.data.gov.uk/wales/bathing-waters/

  Scotland Scottish Environment Protection Agency (SEPA) via their ArcGIS
           MapServer (Open data, no key required).
           https://map.sepa.org.uk/server/rest/services/Open/

Usage
-----
  pip3 install requests beautifulsoup4
  python3 scripts/fetch-uk-bathing-waters.py              # full update
  python3 scripts/fetch-uk-bathing-waters.py --dry-run    # print counts, no write
  python3 scripts/fetch-uk-bathing-waters.py --country wales    # Wales only
  python3 scripts/fetch-uk-bathing-waters.py --country scotland # Scotland only

After running, commit the updated data/bathing-waters.json to the branch.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin

try:
    import requests
except ImportError:
    sys.exit("Missing dependency: requests\nInstall with:  pip3 install requests beautifulsoup4")

try:
    from bs4 import BeautifulSoup
    HAS_BS4 = True
except ImportError:
    HAS_BS4 = False


SCRIPT_DIR   = Path(__file__).parent
BEACHES_JSON = SCRIPT_DIR.parent / "data" / "bathing-waters.json"

# ── Wales (NRW) ────────────────────────────────────────────────────────────────
WALES_BASE    = "https://environment.data.gov.uk/wales/bathing-waters"
# LDA list of all BathingWaterProfileFeature resources (includes lat/long)
WALES_LIST    = f"{WALES_BASE}/doc/BathingWaterProfileFeature.json"
# Fallback: profiles HTML listing page — site IDs extracted, then individual
# JSON resources fetched one at a time.
WALES_PROFILES_HTML = f"{WALES_BASE}/profiles/"
WALES_DOC_TMPL      = f"{WALES_BASE}/doc/bathing-water/{{site_id}}.json"

# ── Scotland (SEPA) ────────────────────────────────────────────────────────────
# ArcGIS MapServer — auto-discovers the bathing-water layer ID.
SEPA_MAPSERVER_BASE = (
    "https://map.sepa.org.uk/server/rest/services/Open/"
    "Utility_and_Governmental_Services/MapServer"
)
# Direct GeoJSON layer query (layer ID discovered at runtime).
SEPA_QUERY_TMPL = SEPA_MAPSERVER_BASE + "/{layer_id}/query"

# Fallback: old SEPA profiles page (server-rendered ASP.NET, scrapeable).
SEPA_OLD_PROFILES = "https://www2.sepa.org.uk/BathingWaters/Profiles.aspx"
SEPA_OLD_DETAIL   = "https://www2.sepa.org.uk/BathingWaters/Default.aspx?id={site_id}"

REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; beach-walk-uk/1.0; "
        "+https://github.com/paulrobinson/beach-walk-uk)"
    )
}
REQUEST_TIMEOUT = 30
INTER_REQUEST_DELAY = 0.15   # seconds between individual-record fetches


# ── Type normalisation ─────────────────────────────────────────────────────────

def _normalise_type(raw: str) -> str:
    low = (raw or "").lower()
    if "coast" in low or "marine" in low or "sea" in low or "tidal" in low:
        return "Coastal"
    if "transit" in low or "estuar" in low or "lagoon" in low:
        return "Transitional"
    if "lake" in low or "loch" in low or "reservoir" in low or "pond" in low:
        return "Lake"
    if "river" in low or "stream" in low or "canal" in low or "burn" in low:
        return "River"
    return "Coastal"


# ── Wales fetch ────────────────────────────────────────────────────────────────

def fetch_wales(session: requests.Session) -> list[dict]:
    print("Fetching Wales bathing waters…")

    # ── Attempt 1: LDA BathingWaterProfileFeature list ──────────────────────
    beaches = _wales_via_lda_list(session)
    if beaches:
        print(f"  {len(beaches)} Wales sites via LDA list.")
        return beaches

    # ── Attempt 2: scrape profiles HTML → fetch individual JSON docs ─────────
    if not HAS_BS4:
        print("  beautifulsoup4 not installed — cannot use HTML-scrape fallback.")
        print("  Install with:  pip3 install beautifulsoup4")
    else:
        beaches = _wales_via_html_scrape(session)
        if beaches:
            print(f"  {len(beaches)} Wales sites via HTML scrape + individual JSON.")
            return beaches

    print("  All Wales fetch strategies failed.")
    _print_manual_hint("Wales", WALES_LIST)
    return []


def _wales_via_lda_list(session: requests.Session) -> list[dict]:
    """Try the LDA bulk list endpoint for all BathingWaterProfileFeature resources."""
    page, beaches = 0, []
    while True:
        try:
            resp = session.get(
                WALES_LIST,
                params={"_pageSize": 200, "_page": page, "_view": "all", "_metadata": "all"},
                timeout=REQUEST_TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            print(f"  LDA list page {page} failed: {exc}")
            return []

        items = data if isinstance(data, list) else (
            data.get("items") or data.get("result") or data.get("results") or []
        )
        if not items:
            break

        for item in items:
            b = _parse_wales_item(item)
            if b:
                beaches.append(b)

        # LDA pagination: stop when fewer items than page size
        if len(items) < 200:
            break
        page += 1
        time.sleep(INTER_REQUEST_DELAY)

    return beaches


def _wales_via_html_scrape(session: requests.Session) -> list[dict]:
    """Scrape the profiles HTML listing to collect site IDs, then fetch each JSON doc."""
    try:
        resp = session.get(WALES_PROFILES_HTML, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
    except Exception as exc:
        print(f"  Profiles HTML fetch failed: {exc}")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
    # Site IDs appear in links like ?site=ukl1402-38800
    site_ids = list(dict.fromkeys(
        m.group(1)
        for a in soup.find_all("a", href=True)
        for m in [re.search(r"[?&]site=(ukl[\w-]+)", a["href"])]
        if m
    ))
    if not site_ids:
        print("  No site IDs found in profiles HTML.")
        return []

    print(f"  Found {len(site_ids)} site IDs in HTML; fetching individual JSON docs…")
    beaches: list[dict] = []
    for i, site_id in enumerate(site_ids):
        url = WALES_DOC_TMPL.format(site_id=site_id)
        try:
            resp = session.get(url, params={"_view": "all"}, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            item = resp.json()
            b = _parse_wales_item(item)
            if b:
                beaches.append(b)
        except Exception as exc:
            print(f"  [{i+1}/{len(site_ids)}] {site_id} failed: {exc}")
        time.sleep(INTER_REQUEST_DELAY)

    return beaches


def _parse_wales_item(item: dict) -> dict | None:
    """Extract a beach record from an NRW LDA JSON item."""
    # Coordinates may live under several key names depending on LDA view
    lat = _float(
        item.get("lat") or item.get("latitude") or item.get("wgs84Lat")
        or (item.get("samplingPoint") or {}).get("lat")
    )
    lon = _float(
        item.get("long") or item.get("lon") or item.get("longitude") or item.get("wgs84Long")
        or (item.get("samplingPoint") or {}).get("long")
    )
    # Geometry block — some LDA responses embed a GeoJSON-style geometry
    if (lat is None or lon is None) and isinstance(item.get("geometry"), dict):
        coords = item["geometry"].get("coordinates")
        if coords and len(coords) >= 2:
            lon, lat = float(coords[0]), float(coords[1])

    name = (
        item.get("name") or item.get("label")
        or item.get("http://www.w3.org/2000/01/rdf-schema#label", [{}])[0].get("@value", "")
        if isinstance(item.get("http://www.w3.org/2000/01/rdf-schema#label"), list)
        else item.get("http://www.w3.org/2000/01/rdf-schema#label", "")
    ) or ""
    name = name.strip()

    if not name or lat is None or lon is None:
        return None

    raw_type = item.get("siteType") or item.get("type") or item.get("waterBodyType") or "Coastal"
    region   = item.get("region") or item.get("catchment") or item.get("RiverBasinDistrict") or ""
    return {
        "name":    name,
        "lat":     round(lat, 4),
        "lon":     round(lon, 4),
        "type":    _normalise_type(str(raw_type)),
        "region":  str(region),
        "country": "Wales",
    }


# ── Scotland fetch ─────────────────────────────────────────────────────────────

def fetch_scotland(session: requests.Session) -> list[dict]:
    print("Fetching Scotland bathing waters from SEPA…")

    # ── Attempt 1: ArcGIS MapServer with auto-discovered layer ───────────────
    layer_id = _sepa_discover_layer(session)
    if layer_id is not None:
        beaches = _sepa_query_layer(session, layer_id)
        if beaches:
            print(f"  {len(beaches)} Scotland sites via ArcGIS layer {layer_id}.")
            return beaches

    # ── Attempt 2: old SEPA profiles page (server-rendered) ─────────────────
    if HAS_BS4:
        beaches = _sepa_via_old_site(session)
        if beaches:
            print(f"  {len(beaches)} Scotland sites via old SEPA site scrape.")
            return beaches
    else:
        print("  beautifulsoup4 not installed — cannot use HTML-scrape fallback.")
        print("  Install with:  pip3 install beautifulsoup4")

    print("  All Scotland fetch strategies failed.")
    _print_manual_hint("Scotland", SEPA_MAPSERVER_BASE + "/layers?f=json")
    return []


def _sepa_discover_layer(session: requests.Session) -> int | None:
    """Query the SEPA MapServer layers endpoint to find the bathing-water layer ID."""
    try:
        resp = session.get(
            SEPA_MAPSERVER_BASE + "/layers",
            params={"f": "json"},
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        print(f"  SEPA MapServer layer discovery failed: {exc}")
        return None

    layers = data.get("layers") or []
    for layer in layers:
        name = (layer.get("name") or "").lower()
        if "bathing" in name or "swimming" in name:
            layer_id = layer.get("id")
            print(f"  Found SEPA bathing water layer: id={layer_id} name={layer.get('name')!r}")
            return layer_id

    # Fallback: if no obvious match, list all layers so the user can inspect
    if layers:
        print("  No 'bathing' layer found. Available layers:")
        for layer in layers:
            print(f"    id={layer.get('id')} — {layer.get('name')!r}")
    return None


def _sepa_query_layer(session: requests.Session, layer_id: int) -> list[dict]:
    """Fetch all features from the given SEPA ArcGIS layer as GeoJSON."""
    url = SEPA_QUERY_TMPL.format(layer_id=layer_id)
    try:
        resp = session.get(
            url,
            params={"where": "1=1", "outFields": "*", "f": "geojson", "outSR": "4326"},
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        geojson = resp.json()
    except Exception as exc:
        print(f"  ArcGIS layer query failed: {exc}")
        return []

    if geojson.get("type") != "FeatureCollection":
        print(f"  Unexpected GeoJSON response: {list(geojson.keys())[:8]}")
        return []

    return _parse_sepa_features(geojson["features"])


def _sepa_via_old_site(session: requests.Session) -> list[dict]:
    """Scrape the old SEPA bathing waters profiles page for site IDs, then fetch detail."""
    try:
        resp = session.get(SEPA_OLD_PROFILES, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
    except Exception as exc:
        print(f"  Old SEPA profiles fetch failed: {exc}")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
    # Site IDs in links like Default.aspx?id=123 or Profiles.aspx?id=123
    site_ids = list(dict.fromkeys(
        m.group(1)
        for a in soup.find_all("a", href=True)
        for m in [re.search(r"[?&]id=(\d+)", a["href"])]
        if m
    ))
    if not site_ids:
        print("  No site IDs found in old SEPA profiles page.")
        return []

    print(f"  Found {len(site_ids)} SEPA site IDs; fetching detail pages…")
    beaches: list[dict] = []
    for i, site_id in enumerate(site_ids):
        url = SEPA_OLD_DETAIL.format(site_id=site_id)
        try:
            resp = session.get(url, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            b = _parse_sepa_detail_html(resp.text, site_id)
            if b:
                beaches.append(b)
        except Exception as exc:
            print(f"  [{i+1}/{len(site_ids)}] site {site_id} failed: {exc}")
        time.sleep(INTER_REQUEST_DELAY)

    return beaches


def _parse_sepa_detail_html(html: str, site_id: str) -> dict | None:
    """Extract name and lat/lon from a SEPA bathing water detail page."""
    soup = BeautifulSoup(html, "html.parser")
    name = ""
    lat = lon = None

    # SEPA detail pages typically embed coordinates in meta tags or a map script
    for meta in soup.find_all("meta"):
        prop = (meta.get("property") or meta.get("name") or "").lower()
        content = meta.get("content", "")
        if "latitude" in prop:
            lat = _float(content)
        elif "longitude" in prop:
            lon = _float(content)

    # Fallback: look for lat/lon in inline <script> content
    if lat is None or lon is None:
        for script in soup.find_all("script"):
            text = script.string or ""
            m_lat = re.search(r"[Ll]at(?:itude)?\s*[=:]\s*([+-]?\d+\.\d+)", text)
            m_lon = re.search(r"[Ll]on(?:g(?:itude)?)?\s*[=:]\s*([+-]?\d+\.\d+)", text)
            if m_lat and m_lon:
                lat, lon = float(m_lat.group(1)), float(m_lon.group(1))
                break

    # Page title often contains the site name
    title_tag = soup.find("title")
    if title_tag:
        name = re.sub(r"\s*[-|].*", "", title_tag.text).strip()
    if not name:
        h1 = soup.find("h1")
        if h1:
            name = h1.text.strip()

    if not name or lat is None or lon is None:
        return None

    return {
        "name":    name,
        "lat":     round(lat, 4),
        "lon":     round(lon, 4),
        "type":    "Coastal",
        "region":  "",
        "country": "Scotland",
    }


def _parse_sepa_features(features: list[dict]) -> list[dict]:
    """Convert SEPA GeoJSON features to the beach-walk-uk schema."""
    beaches: list[dict] = []
    skipped = 0
    for feat in features:
        props = feat.get("properties") or {}
        geom  = feat.get("geometry") or {}

        lat = _float(props.get("LATITUDE") or props.get("Latitude") or props.get("lat"))
        lon = _float(props.get("LONGITUDE") or props.get("Longitude") or props.get("lon"))
        if (lat is None or lon is None) and geom.get("type") == "Point":
            coords = geom.get("coordinates", [])
            if len(coords) >= 2:
                lon, lat = float(coords[0]), float(coords[1])

        name = (
            props.get("BW_NAME") or props.get("NAME") or props.get("name")
            or props.get("Site_Name") or props.get("SITE_NAME")
            or props.get("BathingWaterName") or ""
        ).strip()

        if not name or lat is None or lon is None:
            skipped += 1
            continue

        raw_type = props.get("WATER_TYPE") or props.get("WaterType") or props.get("type") or "Coastal"
        region   = props.get("REGION") or props.get("Region") or props.get("COUNCIL") or props.get("LocalAuthority") or ""

        beaches.append({
            "name":    name,
            "lat":     round(lat, 4),
            "lon":     round(lon, 4),
            "type":    _normalise_type(str(raw_type)),
            "region":  str(region),
            "country": "Scotland",
        })
    return beaches


# ── Helpers ────────────────────────────────────────────────────────────────────

def _float(val: object) -> float | None:
    if val is None:
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _print_manual_hint(country: str, url: str) -> None:
    print(f"""
  All automatic fetch strategies for {country} failed.
  To debug, visit or curl this URL and examine the response:
    {url}
  Then update the endpoint constants near the top of this script.
""")


def _sort_key(beach: dict) -> tuple[str, str, str]:
    return (beach.get("country", "England"), beach.get("region", ""), beach["name"])


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch Wales & Scotland bathing waters and merge into bathing-waters.json",
    )
    parser.add_argument("--dry-run", action="store_true",
                        help="Print counts without writing bathing-waters.json")
    parser.add_argument("--country", choices=["wales", "scotland", "all"], default="all",
                        help="Which country to fetch (default: all)")
    args = parser.parse_args()

    print(f"Loading {BEACHES_JSON.name}…")
    with open(BEACHES_JSON) as f:
        existing: list[dict] = json.load(f)

    for beach in existing:
        beach.setdefault("country", "England")
    print(f"  {len(existing)} existing entries (all England).")

    session = requests.Session()
    session.headers.update(REQUEST_HEADERS)

    new_beaches: list[dict] = []

    if args.country in ("wales", "all"):
        new_beaches.extend(fetch_wales(session))
        time.sleep(0.3)

    if args.country in ("scotland", "all"):
        new_beaches.extend(fetch_scotland(session))

    if not new_beaches:
        print("\nNo new beaches fetched. bathing-waters.json updated with country fields only.")
        if not args.dry_run:
            existing.sort(key=_sort_key)
            with open(BEACHES_JSON, "w") as f:
                json.dump(existing, f, indent=2)
                f.write("\n")
            print(f"Written: {BEACHES_JSON}  ({len(existing)} entries)")
        return

    existing_keys: set[tuple[str, str]] = {
        (b["name"].lower(), b.get("country", "England").lower())
        for b in existing
    }
    fresh = [
        b for b in new_beaches
        if (b["name"].lower(), b["country"].lower()) not in existing_keys
    ]
    duplicates = len(new_beaches) - len(fresh)

    combined = existing + fresh
    combined.sort(key=_sort_key)

    print(
        f"\nSummary: {len(existing)} England + {len(fresh)} new "
        f"({duplicates} duplicates skipped) = {len(combined)} total."
    )

    if args.dry_run:
        print("Dry-run — bathing-waters.json not modified.")
        return

    with open(BEACHES_JSON, "w") as f:
        json.dump(combined, f, indent=2)
        f.write("\n")
    print(f"Written: {BEACHES_JSON}")


if __name__ == "__main__":
    main()
