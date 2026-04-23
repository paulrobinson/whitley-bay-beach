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

  Scotland Scottish Environment Protection Agency (SEPA) via their Open Data Hub
           (ArcGIS-based GeoJSON endpoint).
           https://opendata-scottishepa.hub.arcgis.com

Usage
-----
  pip3 install requests
  python3 scripts/fetch-uk-bathing-waters.py              # full update
  python3 scripts/fetch-uk-bathing-waters.py --dry-run    # print counts, no write
  python3 scripts/fetch-uk-bathing-waters.py --country wales    # Wales only
  python3 scripts/fetch-uk-bathing-waters.py --country scotland # Scotland only

After running, commit the updated data/bathing-waters.json to the branch.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("Missing dependency: requests\nInstall with:  pip3 install requests")


SCRIPT_DIR   = Path(__file__).parent
BEACHES_JSON = SCRIPT_DIR.parent / "data" / "bathing-waters.json"

# ── Wales (NRW) — Defra Linked Data API ───────────────────────────────────────
# Same platform as the EA England API. The searchv2 endpoint returns one JSON
# object per designated bathing water, including lat/long coordinates.
WALES_API = (
    "https://environment.data.gov.uk/wales/bathing-waters/profiles/searchv2"
)

# ── Scotland (SEPA) — ArcGIS Hub GeoJSON download ─────────────────────────────
# SEPA publishes their spatial datasets on the SEPA Open Data Hub (ArcGIS Hub).
# The GeoJSON endpoint gives the full feature collection with point geometry.
# If this URL changes, find the dataset at:
#   https://opendata-scottishepa.hub.arcgis.com/search?q=bathing+waters
SEPA_GEOJSON = (
    "https://opendata-scottishepa.hub.arcgis.com/datasets/"
    "scottishepa::bathing-waters-1.geojson"
)

# Fallback: SEPA ArcGIS MapServer — Utility and Governmental Services layer.
# Layer 0 is typically the bathing waters point layer; adjust if the service
# is restructured.
SEPA_ARCGIS_FALLBACK = (
    "https://map.sepa.org.uk/server/rest/services/Open/"
    "Utility_and_Governmental_Services/MapServer/0/query"
)

REQUEST_HEADERS = {"User-Agent": "beach-walk-uk/fetch-bathing-waters"}
REQUEST_TIMEOUT = 30


# ── Type mapping ───────────────────────────────────────────────────────────────

# Map NRW / SEPA water body categories → the four app types
def _normalise_type(raw: str) -> str:
    low = raw.lower()
    if "coast" in low or "marine" in low or "sea" in low:
        return "Coastal"
    if "transit" in low or "estuar" in low or "lagoon" in low:
        return "Transitional"
    if "lake" in low or "loch" in low or "reservoir" in low or "pond" in low:
        return "Lake"
    if "river" in low or "stream" in low or "canal" in low or "burn" in low:
        return "River"
    return "Coastal"   # default for ambiguous entries


# ── Wales fetch ────────────────────────────────────────────────────────────────

def fetch_wales(session: requests.Session) -> list[dict]:
    """
    Fetch Welsh bathing water locations from the NRW / Defra linked-data API.

    The searchv2 endpoint returns a JSON array of profile summaries, each with:
      { "id": "...", "name": "...", "lat": 51.4, "long": -3.1,
        "siteType": "CoastalBathingWater", "region": "..." }

    Returns a list of dicts in the beach-walk-uk schema.
    """
    print("Fetching Wales bathing waters from NRW…")
    try:
        resp = session.get(
            WALES_API,
            params={"fmt": "json", "lang": "en"},
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as exc:
        print(f"  ERROR fetching Wales data: {exc}")
        _print_manual_hint("Wales", WALES_API)
        return []

    # The API may wrap results in a "items" or "result" key, or return a list
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = data.get("items") or data.get("result") or data.get("results") or []
        if not items:
            print(f"  WARNING: unexpected response shape — keys: {list(data.keys())[:10]}")
            _print_manual_hint("Wales", WALES_API)
            return []
    else:
        print(f"  WARNING: unexpected response type: {type(data)}")
        return []

    beaches: list[dict] = []
    skipped = 0
    for item in items:
        name = item.get("name") or item.get("label") or ""
        lat  = _float(item.get("lat") or item.get("latitude"))
        lon  = _float(item.get("long") or item.get("lon") or item.get("longitude"))
        if not name or lat is None or lon is None:
            skipped += 1
            continue
        raw_type = item.get("siteType") or item.get("type") or "Coastal"
        region   = item.get("region") or item.get("catchment") or ""
        entry: dict = {
            "name":    name,
            "lat":     round(lat, 4),
            "lon":     round(lon, 4),
            "type":    _normalise_type(raw_type),
            "region":  region,
            "country": "Wales",
        }
        beaches.append(entry)

    print(f"  {len(beaches)} Wales sites fetched ({skipped} skipped).")
    return beaches


# ── Scotland fetch ─────────────────────────────────────────────────────────────

def fetch_scotland(session: requests.Session) -> list[dict]:
    """
    Fetch Scottish bathing water locations from the SEPA Open Data Hub.

    Tries two endpoints in order:
      1. ArcGIS Hub GeoJSON download (preferred — complete, single request).
      2. SEPA ArcGIS MapServer query (fallback).

    Returns a list of dicts in the beach-walk-uk schema.
    """
    print("Fetching Scotland bathing waters from SEPA…")

    # ── Attempt 1: ArcGIS Hub GeoJSON download ─────────────────────────────
    try:
        resp = session.get(SEPA_GEOJSON, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        geojson = resp.json()
        if geojson.get("type") == "FeatureCollection":
            beaches = _parse_sepa_geojson(geojson["features"])
            print(f"  {len(beaches)} Scotland sites fetched via Hub GeoJSON.")
            return beaches
    except requests.RequestException as exc:
        print(f"  Hub GeoJSON failed ({exc}), trying ArcGIS MapServer…")

    # ── Attempt 2: ArcGIS MapServer query ──────────────────────────────────
    try:
        resp = session.get(
            SEPA_ARCGIS_FALLBACK,
            params={
                "where": "1=1",
                "outFields": "*",
                "f": "geojson",
                "outSR": "4326",
            },
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        geojson = resp.json()
        if geojson.get("type") == "FeatureCollection":
            beaches = _parse_sepa_geojson(geojson["features"])
            print(f"  {len(beaches)} Scotland sites fetched via ArcGIS MapServer.")
            return beaches
        print(f"  WARNING: ArcGIS MapServer returned unexpected shape: {list(geojson.keys())[:10]}")
    except requests.RequestException as exc:
        print(f"  ArcGIS MapServer also failed: {exc}")

    _print_manual_hint("Scotland", SEPA_GEOJSON)
    return []


def _parse_sepa_geojson(features: list[dict]) -> list[dict]:
    """Convert SEPA GeoJSON features to the beach-walk-uk schema."""
    beaches: list[dict] = []
    skipped = 0
    for feat in features:
        props = feat.get("properties") or {}
        geom  = feat.get("geometry") or {}

        # Prefer explicit lat/long properties; fall back to Point coordinates.
        lat = _float(props.get("LATITUDE") or props.get("lat") or props.get("Latitude"))
        lon = _float(props.get("LONGITUDE") or props.get("lon") or props.get("Longitude"))
        if lat is None or lon is None:
            coords = geom.get("coordinates") if geom.get("type") == "Point" else None
            if coords and len(coords) >= 2:
                lon, lat = float(coords[0]), float(coords[1])

        name = (
            props.get("BW_NAME") or props.get("NAME") or props.get("name")
            or props.get("Site_Name") or props.get("SITE_NAME") or ""
        )
        if not name or lat is None or lon is None:
            skipped += 1
            continue

        raw_type = (
            props.get("WATER_TYPE") or props.get("WaterType") or props.get("type") or "Coastal"
        )
        region = (
            props.get("REGION") or props.get("Region") or props.get("COUNCIL") or ""
        )

        beaches.append({
            "name":    name,
            "lat":     round(lat, 4),
            "lon":     round(lon, 4),
            "type":    _normalise_type(raw_type),
            "region":  region,
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
  ── Manual download for {country} ──────────────────────────────────────
  The automatic fetch failed. Please:
    1. Download the GeoJSON or CSV from:
       {url}
    2. Place the file in scripts/.cache/{country.lower()}/
    3. Re-run this script with --cache-only (add that flag to load a local file)
  ──────────────────────────────────────────────────────────────────────
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

    # Mark all existing entries as England (they are all EA England data).
    for beach in existing:
        beach.setdefault("country", "England")
    print(f"  {len(existing)} existing entries (all England).")

    session = requests.Session()
    session.headers.update(REQUEST_HEADERS)

    new_beaches: list[dict] = []

    if args.country in ("wales", "all"):
        new_beaches.extend(fetch_wales(session))
        time.sleep(0.5)

    if args.country in ("scotland", "all"):
        new_beaches.extend(fetch_scotland(session))

    if not new_beaches:
        print("\nNo new beaches fetched. Existing entries updated with country field only.")
        if not args.dry_run:
            existing.sort(key=_sort_key)
            with open(BEACHES_JSON, "w") as f:
                json.dump(existing, f, indent=2)
                f.write("\n")
            print(f"Written: {BEACHES_JSON}  ({len(existing)} entries, country fields added)")
        return

    # Deduplicate by (name, country): keep the incoming record if there's a
    # name collision within the same country (avoids duplicates on re-runs).
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
