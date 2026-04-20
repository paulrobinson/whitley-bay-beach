#!/usr/bin/env python3
from __future__ import annotations
"""
compute_min_sand.py  —  Populate minSand values in bathing-waters.json

minSand is the fraction of each beach that remains exposed even at Highest
Astronomical Tide (HAT).  Values are stored in bathing-waters.json and used
by the scoring algorithm so wide, flat beaches are not penalised at high tide.

Data sources (both free, Open Government Licence)
--------------------------------------------------
  EA Coastal Flood Boundary 2018 — Extreme Sea Levels shapefile
    Points along the UK coastline with HAT and MHWS tidal datum values
    referenced to Ordnance Datum Newlyn (metres above ODN).

    MANUAL DOWNLOAD REQUIRED (one-time, ~30 MB):
      1. Visit:
         https://www.data.gov.uk/dataset/73834283-7dc4-488a-9583-a920072d9a9d/coastal-design-sea-levels-coastal-flood-boundary-extreme-sea-levels-2018
      2. Click the download link for the shapefile zip
      3. Extract the zip and place ALL extracted files into:
         scripts/.cache/cfb/

  EA LIDAR Composite DTM 1m  (fetched automatically, England only)
    1-metre resolution Digital Terrain Model surveyed at low tide.
    https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs

Method
------
  For each beach (lat/lon from bathing-waters.json):
    1.  Find the nearest CFB coastal point → extract HAT and MHWS
        (metres above ODN; MLWS is estimated as −MHWS, i.e. symmetric
        around Ordnance Datum which approximates Mean Sea Level)
    2.  Convert beach coordinates to British National Grid (EPSG:27700)
    3.  Fetch a PATCH_SIZE_M × PATCH_SIZE_M LIDAR tile via WCS
    4.  Count pixels by elevation band:
          supratidal  — above HAT, up to HAT + BACKSHORE_M (always dry)
          intertidal  — between estimated MLWS and HAT (alternately wet/dry)
    5.  minSand = supratidal / (supratidal + intertidal), rounded to 3 d.p.
    6.  Beaches with < MIN_BEACH_PIXELS total are skipped (no LIDAR data,
        outside England, or point not on coast)

Usage
-----
  pip3 install geopandas rasterio pyproj numpy requests
  python3 scripts/compute_min_sand.py              # update JSON in place
  python3 scripts/compute_min_sand.py --dry-run    # print only, no write
  python3 scripts/compute_min_sand.py --limit 5    # test on first 5 beaches

  Requires outbound HTTPS to environment.data.gov.uk for LIDAR tiles.
  The CFB shapefile must be downloaded manually (see above).

After running, commit the updated data/bathing-waters.json to the branch.
"""

import argparse
import json
import sys
import time
import xml.etree.ElementTree as ET
from io import BytesIO
from pathlib import Path

try:
    import numpy as np
    import requests
    import geopandas as gpd
    import rasterio
    from pyproj import Transformer
    from shapely.geometry import Point
except ImportError as exc:
    sys.exit(
        f"Missing dependency: {exc}\n"
        "Install with:  pip3 install geopandas rasterio pyproj numpy requests shapely"
    )


# ── Configuration ─────────────────────────────────────────────────────────────

SCRIPT_DIR   = Path(__file__).parent
DATA_DIR     = SCRIPT_DIR.parent / "data"
BEACHES_JSON = DATA_DIR / "bathing-waters.json"
CACHE_DIR    = SCRIPT_DIR / ".cache"
CFB_DIR      = CACHE_DIR / "cfb"

# EA LIDAR Composite DTM 1m WCS
LIDAR_WCS = (
    "https://environment.data.gov.uk/spatialdata/"
    "lidar-composite-digital-terrain-model-dtm-1m/wcs"
)

# Analysis parameters
PATCH_SIZE_M     = 400    # Side length (metres, BNG) of the LIDAR query patch
BACKSHORE_M      = 2.5    # Metres above HAT included as walkable dry backshore
MIN_BEACH_PIXELS = 30     # Skip beach if fewer total pixels in beach band
LIDAR_NODATA     = -9999.0
REQUEST_DELAY_S  = 0.2    # Pause between LIDAR requests

# Candidate field names (shapefile DBF names vary between EA releases)
HAT_CANDIDATES  = ["hat_od", "HAT",  "Hat",  "HAT_M",  "hat",  "Hat2017",  "HAT2017"]
MHWS_CANDIDATES = ["mhws_od", "MHWS", "Mhws", "MHWS_M", "mhws", "Mhws2017", "MHWS2017"]
MLWS_CANDIDATES = ["mlws_od", "MLWS", "Mlws", "MLWS_M", "mlws", "Mlws2017", "MLWS2017"]


# ── Coordinate transform ───────────────────────────────────────────────────────

_to_bng = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)

def to_bng(lon: float, lat: float) -> tuple[float, float]:
    return _to_bng.transform(lon, lat)


# ── CFB helpers ────────────────────────────────────────────────────────────────

def _find_field(columns, candidates: list[str]) -> str | None:
    for name in candidates:
        if name in columns:
            return name
    return None


def load_cfb() -> tuple[gpd.GeoDataFrame, str, str, str | None]:
    """
    Load CFB Extreme Sea Levels shapefile from the cache directory.
    Returns (gdf, hat_field, mhws_field, mlws_field_or_None).
    """
    shapefiles = list(CFB_DIR.glob("**/*.shp"))
    if not shapefiles:
        print("\n" + "=" * 70)
        print("CFB SHAPEFILE NOT FOUND")
        print("=" * 70)
        print(
            "\nPlease download the EA Coastal Flood Boundary 2018 data:\n\n"
            "  1. Open this URL in your browser:\n"
            "     https://www.data.gov.uk/dataset/73834283-7dc4-488a-9583-"
            "a920072d9a9d/coastal-design-sea-levels-coastal-flood-boundary-"
            "extreme-sea-levels-2018\n\n"
            "  2. Download the shapefile zip\n\n"
            f"  3. Extract ALL files from the zip into:\n"
            f"     {CFB_DIR}\n\n"
            "  4. Re-run this script\n"
        )
        print("=" * 70 + "\n")
        sys.exit(1)

    # Prefer the Extreme Sea Levels file (densest coastal coverage)
    esl_files = [f for f in shapefiles if "extreme" in f.stem.lower() and "estuary" not in f.stem.lower()]
    chosen = esl_files[0] if esl_files else shapefiles[0]
    print(f"  Loading {chosen.name}…")

    gdf = gpd.read_file(chosen).to_crs("EPSG:27700")  # keep in BNG for accurate distance
    cols = list(gdf.columns)

    hat_field  = _find_field(cols, HAT_CANDIDATES)
    mhws_field = _find_field(cols, MHWS_CANDIDATES)
    mlws_field = _find_field(cols, MLWS_CANDIDATES)

    if not hat_field:
        print(f"  ERROR: could not find HAT field. Available columns: {cols}")
        sys.exit(1)
    if not mhws_field and not mlws_field:
        print(f"  ERROR: could not find MHWS or MLWS field. Available columns: {cols}")
        sys.exit(1)

    print(f"  {len(gdf):,} coastal points | HAT='{hat_field}' MHWS='{mhws_field or '(derive)'}' MLWS='{mlws_field or '(derive)'}'")
    return gdf, hat_field, mhws_field, mlws_field


def nearest_datums(
    lon: float, lat: float,
    cfb_bng: gpd.GeoDataFrame,
    hat_field: str, mhws_field: str | None, mlws_field: str | None
) -> tuple[float, float]:
    """
    Return (hat, mlws) for the nearest CFB point to (lon, lat).
    cfb_bng must be in EPSG:27700 so distance is in metres.
    MLWS is derived as −MHWS if not directly available (ODN ≈ MSL assumption).
    """
    easting, northing = to_bng(lon, lat)
    pt   = Point(easting, northing)
    idx  = cfb_bng.geometry.distance(pt).idxmin()
    row  = cfb_bng.loc[idx]
    hat  = float(row[hat_field])
    if mlws_field:
        mlws = float(row[mlws_field])
    elif mhws_field:
        mlws = -float(row[mhws_field])   # symmetric-tide approximation
    else:
        mlws = hat - 6.0                 # coarse fallback: 6m tidal range
    return hat, mlws


# ── LIDAR WCS helpers ──────────────────────────────────────────────────────────

def _discover_coverage(session: requests.Session, debug: bool = False) -> tuple[str, str]:
    """
    Query WCS 1.0.0 GetCapabilities to find the coverage name.
    Returns (coverage_name_1_0, coverage_id_2_0_1).
    """
    cov_100  = None
    cov_201  = None

    for version in ("1.0.0", "2.0.1"):
        try:
            r = session.get(
                LIDAR_WCS,
                params={"service": "WCS", "version": version, "request": "GetCapabilities"},
                timeout=30,
            )
            r.raise_for_status()
            if debug:
                print(f"  GetCapabilities {version} ({len(r.content)} bytes):")
                print("  " + r.text[:800].replace("\n", " "))
            root = ET.fromstring(r.content)
            if version == "1.0.0":
                # <name> inside <CoverageOfferingBrief>
                el = root.find(".//{http://www.opengis.net/wcs}name")
                if el is None:
                    el = root.find(".//name")
                if el is not None and el.text:
                    cov_100 = el.text.strip()
            else:
                ns = {"wcs": "http://www.opengis.net/wcs/2.0", "ows": "http://www.opengis.net/ows/1.1"}
                for tag in ("wcs:CoverageSummary/wcs:Identifier", "wcs:CoverageSummary/ows:Identifier"):
                    el = root.find(f".//{tag}", ns)
                    if el is not None and el.text:
                        cov_201 = el.text.strip()
                        break
        except Exception as exc:
            print(f"  GetCapabilities {version} failed: {exc}")

    print(f"  WCS 1.0.0 coverage name: {cov_100!r}")
    print(f"  WCS 2.0.1 coverage ID:   {cov_201!r}")
    return (cov_100 or "LidarComposite_DTM_1m"), (cov_201 or "LidarComposite_DTM_1m")


def fetch_lidar_patch(
    easting: float, northing: float,
    cov_100: str, cov_201: str,
    session: requests.Session,
    debug: bool = False,
) -> np.ndarray | None:
    """
    Fetch a PATCH_SIZE_M × PATCH_SIZE_M LIDAR elevation tile (BNG).
    Returns float32 array or None if no data.
    cov_100 is the coverage name for WCS 1.0.0; cov_201 for WCS 2.0.1.
    """
    half  = PATCH_SIZE_M / 2
    e_min, e_max = easting - half,  easting + half
    n_min, n_max = northing - half, northing + half

    px = PATCH_SIZE_M  # e.g. 400 pixels at 1m/pixel

    # Attempt list: (version, params_dict_or_list, description)
    attempts = [
        # WCS 1.0.0 — simpler, widely supported by EA services
        ("1.0.0", [
            ("service",  "WCS"),
            ("version",  "1.0.0"),
            ("request",  "GetCoverage"),
            ("coverage", cov_100),
            ("BBOX",     f"{e_min:.0f},{n_min:.0f},{e_max:.0f},{n_max:.0f}"),
            ("CRS",      "EPSG:27700"),
            ("RESPONSE_CRS", "EPSG:27700"),
            ("FORMAT",   "GeoTIFF"),
            ("WIDTH",    str(px)),
            ("HEIGHT",   str(px)),
        ], "WCS 1.0.0 GeoTIFF"),
        ("1.0.0", [
            ("service",  "WCS"),
            ("version",  "1.0.0"),
            ("request",  "GetCoverage"),
            ("coverage", cov_100),
            ("BBOX",     f"{e_min:.0f},{n_min:.0f},{e_max:.0f},{n_max:.0f}"),
            ("CRS",      "EPSG:27700"),
            ("FORMAT",   "image/tiff"),
            ("WIDTH",    str(px)),
            ("HEIGHT",   str(px)),
        ], "WCS 1.0.0 image/tiff"),
        # WCS 2.0.1 — subset syntax variants
        ("2.0.1", [
            ("service",    "WCS"),
            ("version",    "2.0.1"),
            ("request",    "GetCoverage"),
            ("CoverageID", cov_201),
            ("subset",     f"E({e_min:.0f},{e_max:.0f})"),
            ("subset",     f"N({n_min:.0f},{n_max:.0f})"),
            ("format",     "image/tiff"),
        ], "WCS 2.0.1 bare axes"),
    ]

    for ver, params, desc in attempts:
        try:
            r = session.get(LIDAR_WCS, params=params, timeout=45)
            ct = r.headers.get("Content-Type", "")
            if debug:
                body_preview = r.content[:200].decode("utf-8", errors="replace").replace("\n", " ")
                print(f"    [{desc}] status={r.status_code} ct={ct!r} body={body_preview!r}")
            if r.status_code == 200 and ("tiff" in ct or "octet" in ct):
                with rasterio.open(BytesIO(r.content)) as ds:
                    arr = ds.read(1).astype(np.float32)
                    if ds.nodata is not None:
                        arr[arr == float(ds.nodata)] = LIDAR_NODATA
                return arr
        except Exception as exc:
            if debug:
                print(f"    [{desc}] exception: {exc}")

    return None


# ── minSand calculation ────────────────────────────────────────────────────────

def compute_min_sand(patch: np.ndarray, hat: float, mlws: float) -> float | None:
    """
    Estimate minSand from elevation raster + tidal levels.
    Returns value in [0, 1] or None if insufficient beach pixels.
    """
    valid = patch[patch > LIDAR_NODATA]
    intertidal = int(np.sum((valid >= mlws) & (valid <= hat)))
    supratidal = int(np.sum((valid >  hat) & (valid <= hat + BACKSHORE_M)))
    total = intertidal + supratidal

    if total < MIN_BEACH_PIXELS:
        return None

    return round(supratidal / total, 3)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compute minSand values for all beaches in bathing-waters.json",
    )
    parser.add_argument("--dry-run",  action="store_true",
                        help="Print results without writing to bathing-waters.json")
    parser.add_argument("--limit", type=int, default=0, metavar="N",
                        help="Process only the first N beaches (for testing)")
    parser.add_argument("--list-fields", action="store_true",
                        help="Print CFB shapefile columns and exit")
    parser.add_argument("--debug", action="store_true",
                        help="Print raw WCS response details for each request")
    args = parser.parse_args()

    CACHE_DIR.mkdir(exist_ok=True)
    CFB_DIR.mkdir(exist_ok=True)

    print(f"Loading {BEACHES_JSON.name}…")
    with open(BEACHES_JSON) as f:
        beaches: list[dict] = json.load(f)
    print(f"  {len(beaches)} beaches loaded.")

    print("Loading EA CFB tidal datums…")
    cfb, hat_field, mhws_field, mlws_field = load_cfb()

    if args.list_fields:
        print("\nAll CFB shapefile columns:")
        for col in cfb.columns:
            print(f"  {col}")
        return

    session = requests.Session()
    session.headers["User-Agent"] = "beach-walk-uk/compute-min-sand"

    print("Querying LIDAR WCS coverage…")
    cov_100, cov_201 = _discover_coverage(session, debug=args.debug)
    print(f"  WCS 1.0.0: {cov_100!r}   WCS 2.0.1: {cov_201!r}")

    subset   = beaches[: args.limit] if args.limit else beaches
    total    = len(subset)
    counters = {"computed": 0, "no_lidar": 0, "sparse": 0, "errors": 0}

    for i, beach in enumerate(subset):
        name      = beach["name"]
        lon, lat  = beach["lon"], beach["lat"]
        label     = f"[{i+1}/{total}] {name}"

        try:
            hat, mlws = nearest_datums(lon, lat, cfb, hat_field, mhws_field, mlws_field)
        except Exception as exc:
            print(f"{label}  ERROR (datum lookup): {exc}")
            counters["errors"] += 1
            continue

        easting, northing = to_bng(lon, lat)
        if args.debug:
            print(f"  BNG: E={easting:.0f} N={northing:.0f}")
        patch = fetch_lidar_patch(easting, northing, cov_100, cov_201, session, debug=args.debug)

        if patch is None:
            print(f"{label}  — no LIDAR data")
            counters["no_lidar"] += 1
            time.sleep(REQUEST_DELAY_S)
            continue

        min_sand = compute_min_sand(patch, hat, mlws)

        if min_sand is None:
            print(f"{label}  — sparse pixels  (HAT={hat:.2f}m MLWS={mlws:.2f}m)")
            counters["sparse"] += 1
            time.sleep(REQUEST_DELAY_S)
            continue

        print(f"{label}  minSand={min_sand:.3f}  (HAT={hat:.2f}m MLWS={mlws:.2f}m)")

        # Update the full beaches list (not just the subset slice)
        original_idx = beaches.index(beach)
        if min_sand > 0:
            beaches[original_idx]["minSand"] = min_sand
        elif "minSand" in beaches[original_idx]:
            del beaches[original_idx]["minSand"]

        counters["computed"] += 1
        time.sleep(REQUEST_DELAY_S)

    print(
        f"\nResults: {counters['computed']} computed, "
        f"{counters['no_lidar']} no LIDAR, "
        f"{counters['sparse']} sparse, "
        f"{counters['errors']} errors."
    )

    if args.dry_run:
        print("Dry-run — bathing-waters.json not modified.")
        return

    with open(BEACHES_JSON, "w") as f:
        json.dump(beaches, f, indent=2)
        f.write("\n")
    print(f"Written: {BEACHES_JSON}")


if __name__ == "__main__":
    main()
