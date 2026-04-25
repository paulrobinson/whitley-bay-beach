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
  python3 scripts/fetch-uk-bathing-waters.py              # full update
  python3 scripts/fetch-uk-bathing-waters.py --dry-run    # print counts, no write
  python3 scripts/fetch-uk-bathing-waters.py --country wales    # Wales only
  python3 scripts/fetch-uk-bathing-waters.py --country scotland # Scotland only

No external dependencies — uses only Python standard library.

After running, commit the updated data/bathing-waters.json to the branch.
"""

from __future__ import annotations

import argparse
import json
import math as _math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


SCRIPT_DIR   = Path(__file__).parent
BEACHES_JSON = SCRIPT_DIR.parent / "data" / "bathing-waters.json"

UA = (
    "Mozilla/5.0 (compatible; beach-walk-uk/1.0; "
    "+https://github.com/paulrobinson/beach-walk-uk)"
)

# ── Wales (NRW) ────────────────────────────────────────────────────────────────
WALES_BASE = "https://environment.data.gov.uk/wales/bathing-waters"
WALES_LIST = f"{WALES_BASE}/doc/bathing-water-profile.json"

# ── Scotland (SEPA) ────────────────────────────────────────────────────────────
# Environmental_Monitoring MapServer — layer 1 = "Bathing water points"
SEPA_QUERY_URL = (
    "https://map.sepa.org.uk/server/rest/services/Open/"
    "Environmental_Monitoring/MapServer/1/query"
)

REQUEST_TIMEOUT     = 30
INTER_REQUEST_DELAY = 0.15


# ── HTTP helper (stdlib only) ──────────────────────────────────────────────────

def _get(url: str, params: dict | None = None, timeout: int = REQUEST_TIMEOUT) -> dict | list:
    """GET a URL, return parsed JSON. Raises on HTTP errors."""
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        if resp.status >= 400:
            raise urllib.error.HTTPError(url, resp.status, resp.reason, {}, None)
        return json.loads(resp.read().decode("utf-8"))


# ── OSGB → WGS84 (pure Python, no external dependencies) ─────────────────────
# OS algorithm: "Guide to coordinate systems in Great Britain" (2015).
# Accuracy ~2 m — sufficient for locating bathing waters.

def _osgb_to_latlon(easting: float, northing: float) -> tuple[float, float]:
    """Convert BNG (EPSG:27700) easting/northing to WGS84 (lat, lon)."""
    a, b   = 6377563.396, 6356256.909
    F0     = 0.9996012717
    phi0   = _math.radians(49.0)
    lam0   = _math.radians(-2.0)
    N0, E0 = -100000.0, 400000.0
    e2     = 1.0 - (b / a) ** 2
    n      = (a - b) / (a + b)
    n2, n3 = n * n, n * n * n

    def M(phi: float) -> float:
        return a * F0 * (
            (1 + n + 5/4*n2 + 5/4*n3) * (phi - phi0)
            - (3*n + 3*n2 + 21/8*n3)  * _math.sin(phi - phi0) * _math.cos(phi + phi0)
            + (15/8*n2 + 15/8*n3)     * _math.sin(2*(phi-phi0)) * _math.cos(2*(phi+phi0))
            - 35/24*n3                * _math.sin(3*(phi-phi0)) * _math.cos(3*(phi+phi0))
        )

    phi = phi0
    for _ in range(100):
        dp = (northing - N0 - M(phi)) / (a * F0)
        phi += dp
        if abs(dp) < 1e-12:
            break

    sp, cp, tp = _math.sin(phi), _math.cos(phi), _math.tan(phi)
    nu   = a * F0 / _math.sqrt(1 - e2 * sp**2)
    rho  = a * F0 * (1 - e2) / (1 - e2 * sp**2)**1.5
    eta2 = nu / rho - 1.0
    dE   = easting - E0
    sec  = 1.0 / cp
    t2, t4 = tp**2, tp**4

    phi36 = (phi
        - tp/(2*rho*nu)      * dE**2
        + tp/(24*rho*nu**3)  * (5 + 3*t2 + eta2 - 9*t2*eta2) * dE**4
        - tp/(720*rho*nu**5) * (61 + 90*t2 + 45*t4)           * dE**6)
    lam36 = (lam0
        + sec/nu             * dE
        - sec/(6*nu**3)      * (nu/rho + 2*t2)          * dE**3
        + sec/(120*nu**5)    * (5 + 28*t2 + 24*t4)       * dE**5
        - sec/(5040*nu**7)   * (61 + 662*t2 + 1320*t4 + 720*t2*t4) * dE**7)

    # Helmert: OSGB36 (Airy 1830) → WGS84 (GRS80)
    tx, ty, tz = 446.448, -125.157, 542.060
    arcsec = _math.pi / (180 * 3600)
    rx, ry, rz = 0.1502*arcsec, 0.2470*arcsec, 0.8421*arcsec
    s = -20.4894e-6

    x = nu * cp * _math.cos(lam36)
    y = nu * cp * _math.sin(lam36)
    z = nu * (1 - e2) * sp
    x2 = tx + (1+s)*x - rz*y + ry*z
    y2 = ty + rz*x + (1+s)*y - rx*z
    z2 = tz - ry*x + rx*y  + (1+s)*z

    a2, b2 = 6378137.0, 6356752.314
    e22 = 1.0 - (b2 / a2)**2
    p   = _math.sqrt(x2**2 + y2**2)
    lam_wgs = _math.atan2(y2, x2)
    phi_wgs = _math.atan2(z2, p * (1 - e22))
    phi_new = phi_wgs
    for _ in range(10):
        nu2 = a2 / _math.sqrt(1 - e22 * _math.sin(phi_wgs)**2)
        phi_new = _math.atan2(z2 + e22 * nu2 * _math.sin(phi_wgs), p)
        if abs(phi_new - phi_wgs) < 1e-12:
            break
        phi_wgs = phi_new

    return _math.degrees(phi_new), _math.degrees(lam_wgs)


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

def fetch_wales() -> list[dict]:
    print("Fetching Wales bathing waters…")
    beaches = _wales_via_lda_list()
    if beaches:
        print(f"  {len(beaches)} Wales sites fetched.")
        return beaches
    print("  Wales fetch failed.")
    _print_manual_hint("Wales", WALES_LIST)
    return []


def _wales_via_lda_list() -> list[dict]:
    page, beaches = 0, []
    while True:
        try:
            data = _get(WALES_LIST, {"_pageSize": 200, "_page": page,
                                     "_view": "all", "_metadata": "all"})
        except Exception as exc:
            print(f"  LDA list page {page} failed: {exc}")
            return []

        items = data if isinstance(data, list) else (
            data.get("items") or data.get("result") or data.get("results") or []
        )

        if not items:
            if page == 0:
                top_keys = list(data.keys())[:10] if isinstance(data, dict) else type(data).__name__
                print(f"  LDA list returned no items. Top-level keys: {top_keys}")
            break

        uri_items: list[str] = []
        dict_items_seen = 0
        for item in items:
            if isinstance(item, str) and item.startswith("http"):
                uri_items.append(item)
            elif isinstance(item, dict):
                dict_items_seen += 1
                b = _parse_wales_item(item)
                if b:
                    beaches.append(b)

        # Diagnostic: if we got dict items but parsed 0, dump the first one
        if dict_items_seen > 0 and not beaches and not uri_items and page == 0:
            first = next(i for i in items if isinstance(i, dict))
            print(f"  Got {dict_items_seen} dict items but parsed 0 beaches.")
            print(f"  First item keys: {list(first.keys())[:20]}")
            sample = {k: v for k, v in list(first.items())[:10]}
            print(f"  First item sample: {json.dumps(sample, default=str)[:500]}")

        if uri_items:
            print(f"  Page {page}: {len(uri_items)} URI refs — fetching individual docs…")
            for uri in uri_items:
                json_url = uri if uri.endswith(".json") else uri + ".json"
                try:
                    b = _parse_wales_item(_get(json_url, {"_view": "all"}))
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

    if (lat is None or lon is None) and isinstance(item.get("geometry"), dict):
        coords = item["geometry"].get("coordinates")
        if coords and len(coords) >= 2:
            lon, lat = float(coords[0]), float(coords[1])

    if lat is None or lon is None:
        easting  = _float(
            item.get("easting")
            or _nested(item, "samplingPoint", "easting")
            or _nested(item, "bathingWater", "envelope", "lowerCorner", "easting")
        )
        northing = _float(
            item.get("northing")
            or _nested(item, "samplingPoint", "northing")
            or _nested(item, "bathingWater", "envelope", "lowerCorner", "northing")
        )
        if easting is not None and northing is not None:
            lat, lon = _osgb_to_latlon(easting, northing)

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
        or _nested(item, "bathingWater", "siteType") or "Coastal"
    )
    region = (
        item.get("region") or item.get("catchment") or item.get("RiverBasinDistrict")
        or _nested(item, "bathingWater", "region") or ""
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

def fetch_scotland() -> list[dict]:
    print("Fetching Scotland bathing waters from SEPA…")
    try:
        geojson = _get(SEPA_QUERY_URL,
                       {"where": "1=1", "outFields": "*", "f": "geojson", "outSR": "4326"})
    except Exception as exc:
        print(f"  SEPA query failed: {exc}")
        _print_manual_hint("Scotland",
            SEPA_QUERY_URL + "?where=1=1&outFields=*&f=geojson&outSR=4326")
        return []

    if geojson.get("type") != "FeatureCollection":
        print(f"  Unexpected response shape. Keys: {list(geojson.keys())[:10]}")
        _print_manual_hint("Scotland", SEPA_QUERY_URL)
        return []

    features = geojson["features"]
    beaches = _parse_sepa_features(features)
    if beaches:
        print(f"  {len(beaches)} Scotland sites fetched.")
    else:
        print(f"  No features parsed from {len(features)} SEPA features.")
        if features:
            props = features[0].get("properties") or {}
            geom  = features[0].get("geometry") or {}
            print(f"  First feature property keys: {list(props.keys())[:20]}")
            print(f"  First feature geometry type: {geom.get('type')!r}")
            print(f"  First feature sample props: {json.dumps(dict(list(props.items())[:8]), default=str)[:400]}")
        _print_manual_hint("Scotland", SEPA_QUERY_URL)
    return beaches


def _parse_sepa_features(features: list[dict]) -> list[dict]:
    beaches: list[dict] = []
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
            continue

        raw_type = props.get("WATER_TYPE") or props.get("WaterType") or "Coastal"
        region   = (props.get("REGION") or props.get("Region") or props.get("COUNCIL")
                    or props.get("LocalAuthority") or props.get("LOCAL_AUTHORITY") or "")
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

    new_beaches: list[dict] = []

    if args.country in ("wales", "all"):
        new_beaches.extend(fetch_wales())
        time.sleep(0.3)

    if args.country in ("scotland", "all"):
        new_beaches.extend(fetch_scotland())

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
