#!/usr/bin/env python3
"""
compute_min_sand.py  —  Populate minSand values in bathing-waters.json

minSand is the fraction of each beach that remains exposed even at Highest
Astronomical Tide (HAT).  Values are stored in bathing-waters.json and used
by the scoring algorithm so wide, flat beaches are not penalised at high tide.

Data sources (both free, Open Government Licence)
--------------------------------------------------
  EA Coastal Flood Boundary 2018 (CFB)
    Points along the entire UK coastline with explicit HAT, MHWS and MLWS
    tidal datum values referenced to Ordnance Datum Newlyn (metres above ODN).
    https://environment.data.gov.uk/dataset/84a5c7c0-d465-11e4-b0bd-f0def148f590

  EA LIDAR Composite DTM 1m  (WCS endpoint, England only)
    1-metre resolution Digital Terrain Model, surveyed at low tide so the
    intertidal zone is captured.  Available via OGC WCS 2.0.1.
    https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs

Method
------
  For each beach (lat/lon from bathing-waters.json):
    1.  Find the nearest CFB coastal point → extract HAT and MLWS
        (both metres above ODN, i.e. approximately above mean sea level)
    2.  Convert beach coordinates to British National Grid (EPSG:27700)
    3.  Fetch a PATCH_SIZE_M × PATCH_SIZE_M LIDAR elevation tile via WCS
    4.  Within the tile, classify every pixel:
          intertidal  — elevation in  [MLWS,  HAT]
          supratidal  — elevation in  (HAT,   HAT + BACKSHORE_M]
          (pixels outside this range are sea floor or cliffs/buildings)
    5.  minSand = supratidal_pixels / (intertidal_pixels + supratidal_pixels)
        rounded to 3 decimal places, clamped to [0, 1]
    6.  If fewer than MIN_BEACH_PIXELS total pixels are found (outside England,
        data gap, or inland GPS point) the beach is skipped and its existing
        value (or the default 0) is kept.

Usage
-----
  pip install geopandas rasterio pyproj numpy requests
  python scripts/compute_min_sand.py              # update JSON in place
  python scripts/compute_min_sand.py --dry-run    # print results, no write
  python scripts/compute_min_sand.py --limit 10   # test on first 10 beaches

  Requires outbound HTTPS to environment.data.gov.uk.
  Caches CFB shapefile locally in scripts/.cache/ after first download.

Notes
-----
  Scotland, Wales and Northern Ireland beaches will report "no LIDAR data"
  and are skipped (EA LIDAR covers England only).  Their minSand values
  remain at the default 0.

  Re-run whenever new beaches are added to bathing-waters.json.
"""

import argparse
import json
import sys
import time
import zipfile
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
    print(f"Missing dependency: {exc}")
    print("Install with:  pip install geopandas rasterio pyproj numpy requests shapely")
    sys.exit(1)


# ── Configuration ─────────────────────────────────────────────────────────────

SCRIPT_DIR  = Path(__file__).parent
DATA_DIR    = SCRIPT_DIR.parent / "data"
BEACHES_JSON = DATA_DIR / "bathing-waters.json"
CACHE_DIR   = SCRIPT_DIR / ".cache"

# EA Coastal Flood Boundary 2018 — dataset landing page if download URL changes:
# https://environment.data.gov.uk/dataset/84a5c7c0-d465-11e4-b0bd-f0def148f590
CFB_DOWNLOAD_URL = (
    "https://environment.data.gov.uk/UserDownloads/interactive/"
    "8cf3f9e42f2e499798adbb9a50ea6c3284a5c7c0d46511e4b0bdf0def148f590/"
    "CFBGaugeData2018.zip"
)
CFB_FALLBACK_URL = (
    "https://www.data.gov.uk/dataset/73834283-7dc4-488a-9583-a920072d9a9d/"
    "coastal-design-sea-levels-coastal-flood-boundary-extreme-sea-levels-2018"
)

# Expected field names in the CFB gauge shapefile (10-char DBF limit)
CFB_HAT_FIELD  = "Hat2017"    # Highest Astronomical Tide, metres above ODN
CFB_MLWS_FIELD = "Mlws2017"   # Mean Low Water Springs, metres above ODN
# Fallback if field names differ (inspect with --list-cfb-fields)
CFB_HAT_ALTERNATIVES  = ["HAT2017",  "hat2017",  "HAT",  "hat"]
CFB_MLWS_ALTERNATIVES = ["MLWS2017", "mlws2017", "MLWS", "mlws", "Mlws"]

# EA LIDAR Composite DTM 1m WCS
LIDAR_WCS = (
    "https://environment.data.gov.uk/spatialdata/"
    "lidar-composite-digital-terrain-model-dtm-1m/wcs"
)

# Analysis parameters
PATCH_SIZE_M     = 400     # Side length (metres, BNG) of LIDAR query window
BACKSHORE_M      = 2.5     # Metres above HAT to include as walkable backshore
MIN_BEACH_PIXELS = 30      # Skip beach if fewer total beach pixels found
LIDAR_NODATA     = -9999.0 # Sentinel for LIDAR nodata pixels
REQUEST_DELAY_S  = 0.15    # Polite pause between WCS requests


# ── Coordinate transform ───────────────────────────────────────────────────────

_wgs84_to_bng = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)

def to_bng(lon: float, lat: float) -> tuple[float, float]:
    """Convert WGS84 longitude/latitude to BNG easting/northing."""
    return _wgs84_to_bng.transform(lon, lat)


# ── CFB helpers ────────────────────────────────────────────────────────────────

def _resolve_field(gdf: gpd.GeoDataFrame, primary: str, alternatives: list[str]) -> str:
    """Return the first matching field name from a GeoDataFrame."""
    for name in [primary] + alternatives:
        if name in gdf.columns:
            return name
    raise KeyError(
        f"Could not find field '{primary}' in CFB shapefile. "
        f"Available columns: {list(gdf.columns)}\n"
        f"Run with --list-cfb-fields to inspect the file."
    )


def load_cfb(cache_dir: Path) -> gpd.GeoDataFrame:
    """
    Download (once) and load the EA CFB 2018 gauge shapefile.
    Returns a GeoDataFrame in WGS84 (EPSG:4326).
    """
    cache_cfb = cache_dir / "cfb"
    # Look for any .shp in the cache directory
    existing = list(cache_cfb.glob("*.shp"))
    if existing:
        print(f"  Loading CFB from cache ({existing[0].name})…")
        return gpd.read_file(existing[0]).to_crs("EPSG:4326")

    print("  Downloading EA CFB 2018 shapefile…")
    cache_cfb.mkdir(parents=True, exist_ok=True)

    try:
        r = requests.get(CFB_DOWNLOAD_URL, timeout=120, stream=True)
        r.raise_for_status()
        content = r.content
    except requests.RequestException as exc:
        raise RuntimeError(
            f"Failed to download CFB shapefile: {exc}\n\n"
            "Please download it manually from:\n"
            f"  {CFB_FALLBACK_URL}\n\n"
            "Then extract the contents to:\n"
            f"  {cache_cfb}\n\n"
            "and re-run this script."
        ) from exc

    with zipfile.ZipFile(BytesIO(content)) as z:
        z.extractall(cache_cfb)

    shapefiles = list(cache_cfb.glob("**/*.shp"))
    if not shapefiles:
        raise RuntimeError(f"No .shp files found after extracting CFB zip to {cache_cfb}")

    # Prefer a file with "Gauge" or "gauge" in the name (contains HAT/MLWS datums)
    gauge_files = [f for f in shapefiles if "gauge" in f.name.lower()]
    chosen = gauge_files[0] if gauge_files else shapefiles[0]
    print(f"  Loaded CFB from {chosen.name}")
    gdf = gpd.read_file(chosen).to_crs("EPSG:4326")
    print(f"  {len(gdf):,} CFB coastal points loaded.")
    return gdf


def nearest_cfb_datums(
    lon: float, lat: float, cfb: gpd.GeoDataFrame,
    hat_field: str, mlws_field: str
) -> tuple[float, float]:
    """Return (hat, mlws) from the nearest CFB point to (lon, lat)."""
    pt = Point(lon, lat)
    idx = cfb.geometry.distance(pt).idxmin()
    row = cfb.loc[idx]
    return float(row[hat_field]), float(row[mlws_field])


# ── LIDAR WCS helpers ──────────────────────────────────────────────────────────

def _get_lidar_coverage_id(session: requests.Session) -> str:
    """
    Query WCS GetCapabilities to find the correct coverage ID.
    Falls back to a known common value if parsing fails.
    """
    try:
        r = session.get(
            LIDAR_WCS,
            params={"service": "WCS", "version": "2.0.1", "request": "GetCapabilities"},
            timeout=30,
        )
        r.raise_for_status()
        # Simple text search — avoids an XML dependency
        xml = r.text
        for tag in ("wcs:Identifier", "ows:Identifier", "Identifier"):
            start = xml.find(f"<{tag}>")
            if start != -1:
                end = xml.find(f"</{tag}>", start)
                if end != -1:
                    return xml[start + len(tag) + 2 : end].strip()
    except Exception:
        pass
    return "LidarComposite_DTM_1m"  # best-guess fallback


def fetch_lidar_patch(
    easting: float, northing: float,
    coverage_id: str,
    session: requests.Session,
) -> np.ndarray | None:
    """
    Query the LIDAR WCS for a PATCH_SIZE_M × PATCH_SIZE_M tile centred on
    the given BNG easting/northing.  Returns a float32 elevation array or
    None if no data is available for this location.
    """
    half  = PATCH_SIZE_M / 2
    e_min = easting  - half
    e_max = easting  + half
    n_min = northing - half
    n_max = northing + half

    # WCS 2.0.1 subsetting — axis names from EA GetCapabilities are E and N
    params = [
        ("service",    "WCS"),
        ("version",    "2.0.1"),
        ("request",    "GetCoverage"),
        ("CoverageID", coverage_id),
        ("subset",     f"E,EPSG:27700({e_min:.0f},{e_max:.0f})"),
        ("subset",     f"N,EPSG:27700({n_min:.0f},{n_max:.0f})"),
        ("format",     "image/tiff"),
    ]

    try:
        r = session.get(LIDAR_WCS, params=params, timeout=45)
        if r.status_code != 200:
            return None
        content_type = r.headers.get("Content-Type", "")
        if "xml" in content_type or "html" in content_type:
            # Server returned an error document, not a raster
            return None

        with rasterio.open(BytesIO(r.content)) as ds:
            arr = ds.read(1).astype(np.float32)
            if ds.nodata is not None:
                arr[arr == float(ds.nodata)] = LIDAR_NODATA
            return arr

    except Exception:
        return None


# ── minSand calculation ────────────────────────────────────────────────────────

def compute_min_sand(
    patch: np.ndarray,
    hat: float,
    mlws: float,
    backshore_m: float = BACKSHORE_M,
    min_pixels: int = MIN_BEACH_PIXELS,
) -> float | None:
    """
    Estimate minSand from an elevation raster and tidal datum levels.

    Parameters
    ----------
    patch       : 2-D float32 array of elevation values (metres above ODN)
    hat         : Highest Astronomical Tide level (metres above ODN)
    mlws        : Mean Low Water Springs level (metres above ODN)
    backshore_m : Height above HAT to include as walkable backshore

    Returns
    -------
    minSand in [0, 1] rounded to 3 d.p., or None if insufficient data.
    """
    valid = patch[patch > LIDAR_NODATA]

    # Intertidal zone: alternately covered and exposed by normal tides
    intertidal = int(np.sum((valid >= mlws) & (valid <= hat)))
    # Supratidal zone: above HAT — the "always dry" walkable backshore
    supratidal = int(np.sum((valid > hat)  & (valid <= hat + backshore_m)))

    total = intertidal + supratidal
    if total < min_pixels:
        return None

    return round(supratidal / total, 3)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compute minSand values for all beaches in bathing-waters.json",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Compute and print values but do not write to bathing-waters.json",
    )
    parser.add_argument(
        "--limit", type=int, default=0, metavar="N",
        help="Process only the first N beaches (useful for testing)",
    )
    parser.add_argument(
        "--list-cfb-fields", action="store_true",
        help="Download CFB shapefile, print its column names, and exit",
    )
    args = parser.parse_args()

    CACHE_DIR.mkdir(exist_ok=True)

    # ── Load beaches ──────────────────────────────────────────────────────────
    print(f"Loading {BEACHES_JSON.name}…")
    with open(BEACHES_JSON) as f:
        beaches: list[dict] = json.load(f)
    print(f"  {len(beaches)} beaches loaded.")

    # ── Load CFB tidal datums ─────────────────────────────────────────────────
    print("Loading EA Coastal Flood Boundary tidal datums…")
    cfb = load_cfb(CACHE_DIR)

    if args.list_cfb_fields:
        print("\nCFB shapefile columns:")
        for col in cfb.columns:
            print(f"  {col}")
        return

    hat_field  = _resolve_field(cfb, CFB_HAT_FIELD,  CFB_HAT_ALTERNATIVES)
    mlws_field = _resolve_field(cfb, CFB_MLWS_FIELD, CFB_MLWS_ALTERNATIVES)
    print(f"  Using fields: HAT='{hat_field}'  MLWS='{mlws_field}'")

    # ── Discover LIDAR coverage ID ────────────────────────────────────────────
    session = requests.Session()
    session.headers["User-Agent"] = "beach-walk-uk/compute-min-sand"

    print("Querying LIDAR WCS capabilities…")
    coverage_id = _get_lidar_coverage_id(session)
    print(f"  Coverage ID: {coverage_id}")

    # ── Process each beach ────────────────────────────────────────────────────
    subset = beaches[: args.limit] if args.limit else beaches
    total  = len(subset)

    counters = {"computed": 0, "skipped_no_data": 0, "skipped_sparse": 0, "errors": 0}

    for i, beach in enumerate(subset):
        name = beach["name"]
        lon, lat = beach["lon"], beach["lat"]
        prefix = f"[{i+1}/{total}] {name}"

        try:
            hat, mlws = nearest_cfb_datums(lon, lat, cfb, hat_field, mlws_field)
        except Exception as exc:
            print(f"{prefix}  ERROR (CFB lookup): {exc}")
            counters["errors"] += 1
            continue

        easting, northing = to_bng(lon, lat)
        patch = fetch_lidar_patch(easting, northing, coverage_id, session)

        if patch is None:
            print(f"{prefix}  — no LIDAR data (outside England?)")
            counters["skipped_no_data"] += 1
            time.sleep(REQUEST_DELAY_S)
            continue

        min_sand = compute_min_sand(patch, hat, mlws)

        if min_sand is None:
            print(
                f"{prefix}  — insufficient beach pixels "
                f"(HAT={hat:.2f}m  MLWS={mlws:.2f}m)"
            )
            counters["skipped_sparse"] += 1
            time.sleep(REQUEST_DELAY_S)
            continue

        print(
            f"{prefix}  minSand={min_sand:.3f}"
            f"  (HAT={hat:.2f}m  MLWS={mlws:.2f}m)"
        )

        # Write into the in-memory list (matched by position in original list)
        original_idx = beaches.index(beach)
        if min_sand > 0:
            beaches[original_idx]["minSand"] = min_sand
        elif "minSand" in beaches[original_idx]:
            del beaches[original_idx]["minSand"]

        counters["computed"] += 1
        time.sleep(REQUEST_DELAY_S)

    # ── Summary ───────────────────────────────────────────────────────────────
    print(
        f"\nResults: {counters['computed']} computed, "
        f"{counters['skipped_no_data']} no LIDAR data, "
        f"{counters['skipped_sparse']} sparse pixels, "
        f"{counters['errors']} errors."
    )

    if args.dry_run:
        print("Dry-run mode — bathing-waters.json not updated.")
        return

    with open(BEACHES_JSON, "w") as f:
        json.dump(beaches, f, indent=2)
        f.write("\n")
    print(f"Written: {BEACHES_JSON}")


if __name__ == "__main__":
    main()
