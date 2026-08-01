#!/usr/bin/env python3
"""Generate the app icons from one piece of source artwork.

    python3 scripts/make-icons.py path/to/artwork.png

Writes into build/, which is electron-builder's buildResources directory:

    icon.icns   macOS — a rounded square on Apple's 824-in-1024 grid, so it
                sits the same size as its neighbours in the Dock
    icon.png    Linux — full-bleed; those desktops draw the icon as given
    icon.ico    Windows — multi-resolution, 16 through 256

Source artwork should be square and at least 1024x1024. Artwork that sits on a
plain background (a tile on a white page, say) is detected and lifted off it;
artwork composed edge to edge is used as-is and gets its corners rounded here.

Requires Pillow:  pip install Pillow
Requires iconutil for the .icns, which ships with macOS. On other platforms the
icns step is skipped with a note — only macOS builds need it.
"""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("Pillow is required:  pip install Pillow")

BUILD = Path(__file__).resolve().parent.parent / "build"

# Apple's app-icon grid: an 824pt rounded square centred in a 1024pt canvas,
# with a 185.4pt corner radius.
GRID_CANVAS = 1024
GRID_TILE = 824
GRID_RADIUS_RATIO = 185.4 / 824

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
ICNS_BASES = (16, 32, 128, 256, 512)


def load_square(path: Path) -> Image.Image:
    """Loads the artwork, lifting it off a plain background if it sits on one."""
    img = Image.open(path).convert("RGBA")

    corners = [(0, 0), (img.width - 1, 0), (0, img.height - 1), (img.width - 1, img.height - 1)]
    # If every corner is the same near-uniform colour, the artwork is probably a
    # shape on a background. Flood-filling from the corners removes it while
    # preserving the artwork's own edge, rather than guessing a corner radius.
    sample = [img.getpixel(c)[:3] for c in corners]
    uniform = all(
        max(abs(a - b) for a, b in zip(sample[0], other)) < 12 for other in sample[1:]
    )

    if uniform:
        probe = img.copy()
        for corner in corners:
            ImageDraw.floodfill(probe, corner, (0, 0, 0, 0), thresh=40)
        bbox = probe.getbbox()
        # Only accept it if a meaningful border was actually removed; a
        # full-bleed image whose corners happen to match must be left alone.
        if bbox and (bbox[2] - bbox[0]) < img.width * 0.97:
            print(f"  lifted artwork off its background: {img.size} -> {bbox}")
            img = probe.crop(bbox)

    side = max(img.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(img, ((side - img.width) // 2, (side - img.height) // 2), img)
    return square


def rounded(square: Image.Image, size: int, radius_ratio: float) -> Image.Image:
    """Rounds the corners, masking at 4x so the curve downsamples cleanly."""
    art = square.resize((size, size), Image.LANCZOS)
    scale = 4
    mask = Image.new("L", (size * scale, size * scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size * scale - 1, size * scale - 1),
        radius=round(size * radius_ratio * scale),
        fill=255,
    )
    art.putalpha(mask.resize((size, size), Image.LANCZOS))
    return art


def write_icns(tile_source: Image.Image) -> bool:
    if not shutil.which("iconutil"):
        print("  skipped icon.icns — iconutil is macOS-only")
        return False

    tile = rounded(tile_source, GRID_TILE, GRID_RADIUS_RATIO)
    padded = Image.new("RGBA", (GRID_CANVAS, GRID_CANVAS), (0, 0, 0, 0))
    inset = (GRID_CANVAS - GRID_TILE) // 2
    padded.paste(tile, (inset, inset), tile)

    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for base in ICNS_BASES:
            padded.resize((base, base), Image.LANCZOS).save(iconset / f"icon_{base}x{base}.png")
            padded.resize((base * 2, base * 2), Image.LANCZOS).save(
                iconset / f"icon_{base}x{base}@2x.png"
            )
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(BUILD / "icon.icns")], check=True
        )
    print(f"  icon.icns  macOS, {GRID_TILE} rounded tile centred in {GRID_CANVAS}")
    return True


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)

    source = Path(sys.argv[1]).expanduser()
    if not source.exists():
        sys.exit(f"No such file: {source}")

    BUILD.mkdir(exist_ok=True)
    print(f"source: {source.name}")

    square = load_square(source)
    if min(square.size) < 1024:
        print(f"  warning: source is only {square.width}px; 1024 or larger is better")

    full = square.resize((1024, 1024), Image.LANCZOS)
    full.save(BUILD / "icon.png")
    print("  icon.png   Linux, full-bleed 1024")

    full.save(BUILD / "icon.ico", sizes=ICO_SIZES)
    print(f"  icon.ico   Windows, {len(ICO_SIZES)} sizes")

    write_icns(square)
    print("\nRebuild to pick them up:  pnpm dist:mac  /  pnpm dist:linux")


if __name__ == "__main__":
    main()
