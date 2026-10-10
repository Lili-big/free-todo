from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


ICO_SIZES = [(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Windows and renderer icons from the approved square source image.")
    parser.add_argument("source", type=Path, help="RGBA square source PNG")
    parser.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parents[1])
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    workspace = args.workspace.resolve()
    source = args.source.resolve()
    build_dir = workspace / "build"
    renderer_assets = workspace / "src" / "renderer" / "src" / "assets"
    build_dir.mkdir(parents=True, exist_ok=True)
    renderer_assets.mkdir(parents=True, exist_ok=True)

    with Image.open(source) as opened:
        image = opened.convert("RGBA")
    if image.width != image.height:
        raise ValueError(f"Icon source must be square, got {image.size}")
    if image.getchannel("A").getextrema()[0] == 255:
        raise ValueError("Icon source must preserve transparent pixels outside the app tile")

    icon_1024 = image.resize((1024, 1024), Image.Resampling.LANCZOS)
    icon_512 = icon_1024.resize((512, 512), Image.Resampling.LANCZOS)
    icon_256 = icon_1024.resize((256, 256), Image.Resampling.LANCZOS)

    icon_512.save(build_dir / "icon.png", format="PNG", optimize=True)
    icon_1024.save(build_dir / "icon.ico", format="ICO", sizes=ICO_SIZES)
    icon_256.save(renderer_assets / "app-icon.png", format="PNG", optimize=True)

    print(build_dir / "icon.ico")
    print(build_dir / "icon.png")
    print(renderer_assets / "app-icon.png")


if __name__ == "__main__":
    main()
