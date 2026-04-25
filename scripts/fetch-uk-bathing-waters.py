#!/usr/bin/env python3
"""
fetch-uk-bathing-waters.py  —  Fetch bathing water locations for Wales and
Scotland and merge them into data/bathing-waters.json alongside the existing
England data.

Data sources
------------
  England  Environment Agency (EA) — data already present; gains country field.

  Wales    Natural Resources Wales (NRW) via the Defra Linked Data platform.
           Resource class: bathing-water-profile
           https://environment.data.gov.uk/wales/bathing-waters/

  Scotland Scottish Environment Protection Agency (SEPA) via their ArcGIS
           Environmental_Monitoring MapServer, layer 1 (bathing water points).
           https://map.sepa.org.uk/server/rest/services/Open/Environmental_Monitoring/

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

# pyproj is used to convert OSGB (easting/northing) → WGS84 (lat/lon).
# Already a dependency of compute_min_sand.py.
try:
    from pyproj import Transformer
    _osgb_to_wgs84 = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
    HAS_PYPROJ = True
except ImportError:
    HAS_PYPROJ = False


SCRIPT_DIR   = Path(__file__).parent
BEACHES_JSON = SCRIPT_DIR.parent / "data" / "bathing-waters.json"

# ── Wales (NRW) ────────────────────────────────────────────────────────────────
WALES_BASE     = "https://environment.data.gov.uk/wales/bathing-waters"
# LDA list endpoint — class is "bathing-water-profile" (all lower-case, hyphenated)
WALES_LIST     = f"{WALES_BASE}/doc/bathing-water-profile.json"
# Individual resource template (site ID like ukl1402-38800)
WALES_DOC_TMPL = f"{WALES_BASE}/doc/bathing-water-profile/{{site_id}}.json"

# ── Scotland (SEPA) ────────────────────────────────────────────────────────────
# Environmental_Monitoring MapServer — layer 1 = "Bathing water points"
SEPA_MAPSERVER = (
    "https://map.sepa.org.uk/server/rest/services/Open/"
    "Environmental_Monitoring/MapServer"
)
SEPA_BW_LAYER  = 1   # "Bathing water points"
SEPA_QUERY_URL = f"{SEPA_MAPSERVER}/{SEPA_BW_LAYER}/query"

REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; beach-walk-uk/1.0; "
        "+https://github.com/paulrobinson/beach-walk-uk)"
    )
}
REQUEST_TIMEOUT  = 30
INTER_REQUEST_DELAY = 0.15   # seconds between individual-record fetches


# ── Coordinate helpers ─────────────────────────────────────────────────────────

def _osgb_to_latlon(easting: float, northing: float) -> tuple[float, float] | None:
    """Convert British National Grid (EPSG:27700) to WGS84 (lat, lon)."""
    if not HAS_PYPROJ:
        return None
    lon, lat = _osgb_to_wgs84.transform(easting, northing)
    return lat, lon


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
    beaches = _wales_via_lda_list(session)
    if beaches:
        print(f"  {len(beaches)} Wales sites fetched.")
        return beaches
    print("  Wales fetch failed.")
    _print_manual_hint("Wales", WALES_LIST)
    return []


def _wales_via_lda_list(session: requests.Session) -> list[dict]:
    """Fetch the bathing-water-profile LDA list, paginating until complete."""
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
            if page == 0:
                top_keys = list(data.keys())[:10] if isinstance(data, dict) else type(data).__name__
                print(f"  LDA list returned no items. Response top-level keys: {top_keys}")
            break

        # Items may be full dicts OR bare URI strings (LDA returns URIs in some views).
        uri_items: list[str] = []
        for item in items:
            if isinstance(item, str) and item.startswith("http"):
                uri_items.append(item)
            elif isinstance(item, dict):
                b = _parse_wales_item(item)
                if b:
                    beaches.append(b)

        if uri_items:
            print(f"  Page {page}: {len(uri_items)} URI refs — fetching individual docs…")
            for uri in uri_items:
                json_url = (uri if uri.endswith(".json") else uri + ".json")
                try:
                    r = session.get(json_url, params={"_view": "all"}, timeout=REQUEST_TIMEOUT)
                    r.raise_for_status()
                    b = _parse_wales_item(r.json())
                    if b:
                        beaches.append(b)
                except Exception as exc:
                    print(f"    {uri} → {exc}")
                time.sleep(INTER_REQUEST_DELAY)

        if len(items) < 200:
            break
        page += 1
        time.sleep(INTER_REQUEST_DELAY)

    return beaches


def _parse_wales_item(item: dict) -> dict | None:
    """Extract a beach record from an NRW LDA bathing-water-profile JSON item."""
    # --- Coordinates: try WGS84 directly first, then convert from OSGB --------
    lat = _float(
        item.get("lat") or item.get("latitude") or item.get("wgs84Lat")
        or _nested(item, "samplingPoint", "lat")
        or _nested(item, "bathingWater", "lat")
    )
    lon = _float(
        item.get("long") or item.get("lon") or item.get("longitude") or item.get("wgs84Long")
        or _nested(item, "samplingPoint", "long")
        or _nested(item, "bathingWater", "long")
    )

    # GeoJSON-style geometry block
    if (lat is None or lon is None) and isinstance(item.get("geometry"), dict):
        coords = item["geometry"].get("coordinates")
        if coords and len(coords) >= 2:
            lon, lat = float(coords[0]), float(coords[1])

    # OSGB easting/northing → WGS84 (coordinates often stored as BNG in NRW data)
    if lat is None or lon is None:
        easting  = _float(
            item.get("easting") or item.get("samplingPoint.easting")
            or _nested(item, "samplingPoint", "easting")
            or _nested(item, "bathingWater", "envelope", "lowerCorner", "easting")
        )
        northing = _float(
            item.get("northing") or item.get("samplingPoint.northing")
            or _nested(item, "samplingPoint", "northing")
            or _nested(item, "bathingWater", "envelope", "lowerCorner", "northing")
        )
        if easting is not None and northing is not None:
            result = _osgb_to_latlon(easting, northing)
            if result:
                lat, lon = result

    # --- Name -----------------------------------------------------------------
    name = (
        item.get("name") or item.get("label") or item.get("bathingWaterName")
        or _nested(item, "bathingWater", "name")
        or _nested(item, "bathingWater", "label")
        or ""
    )
    if isinstance(name, list):
        name = name[0] if name else ""
    name = str(name).strip()

    if not name or lat is None or lon is None:
        return None

    raw_type = (
        item.get("siteType") or item.get("type") or item.get("waterBodyType")
        or _nested(item, "bathingWater", "siteType")
        or "Coastal"
    )
    region = (
        item.get("region") or item.get("catchment") or item.get("RiverBasinDistrict")
        or _nested(item, "bathingWater", "region")
        or ""
    )
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

    try:
        resp = session.get(
            SEPA_QUERY_URL,
            params={"where": "1=1", "outFields": "*", "f": "geojson", "outSR": "4326"},
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        geojson = resp.json()
    except Exception as exc:
        print(f"  SEPA query failed: {exc}")
        _print_manual_hint("Scotland", SEPA_QUERY_URL + "?where=1=1&outFields=*&f=geojson&outSR=4326")
        return []

    if geojson.get("type") != "FeatureCollection":
        print(f"  Unexpected response shape. Keys: {list(geojson.keys())[:10]}")
        _print_manual_hint("Scotland", SEPA_QUERY_URL)
        return []

    beaches = _parse_sepa_features(geojson["features"])
    if beaches:
        print(f"  {len(beaches)} Scotland sites fetched.")
    else:
        print("  No features parsed from SEPA response.")
        _print_manual_hint("Scotland", SEPA_QUERY_URL)
    return beaches


def _parse_sepa_features(features: list[dict]) -> list[dict]:
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
            or props.get("BathingWaterName") or props.get("BATHING_WATER_NAME") or ""
        ).strip()

        if not name or lat is None or lon is None:
            skipped += 1
            continue

        raw_type = (
            props.get("WATER_TYPE") or props.get("WaterType") or props.get("type") or "Coastal"
        )
        region = (
            props.get("REGION") or props.get("Region") or props.get("COUNCIL")
            or props.get("LocalAuthority") or props.get("LOCAL_AUTHORITY") or ""
        )
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


def _nested(obj: dict, *keys: str) -> object:
    """Safely traverse nested dicts: _nested(d, 'a', 'b') → d['a']['b'] or None."""
    cur = obj
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def _print_manual_hint(country: str, url: str) -> None:
    print(f"""
  All automatic fetch strategies for {country} failed.
  Examine the response to diagnose:
    curl '{url}' | python3 -m json.tool | head -80
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
