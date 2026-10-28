"""从用户提供的两张原图生成品牌图标；需要 Pillow 和项目的 pnpm tauri。

运行：python3 scripts/generate-brand-icons.py
macOS 留白由现有 macos-icon.gen.py 生成，SVG 仅嵌入原图，不描摹路径。
"""

import base64
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "src-tauri/icons"
SOURCE = ICONS / "source/bee1024_logo-notext-white.png"


def main():
    source = Image.open(SOURCE).convert("RGBA")
    encoded = base64.b64encode(SOURCE.read_bytes()).decode("ascii")
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" '
        'viewBox="0 0 512 512">\n'
        '  <defs><clipPath id="bee-tile"><rect width="512" height="512" '
        'rx="90"/></clipPath></defs>\n'
        '  <image width="512" height="512" clip-path="url(#bee-tile)" '
        f'href="data:image/png;base64,{encoded}"/>\n</svg>\n'
    )
    for path in [ROOT / "public/icon.svg", ICONS / "icon.svg"]:
        path.write_text(svg)
    maskable_svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" '
        'viewBox="0 0 512 512">\n  <rect width="512" height="512" fill="white"/>\n'
        '  <image x="71.68" y="71.68" width="368.64" height="368.64" '
        f'href="data:image/png;base64,{encoded}"/>\n</svg>\n'
    )
    (ROOT / "public/icon-maskable.svg").write_text(maskable_svg)

    tile = source.resize((1024, 1024), Image.Resampling.LANCZOS)
    alpha = Image.new("L", tile.size)
    ImageDraw.Draw(alpha).rounded_rectangle((0, 0, 1023, 1023), radius=180, fill=255)
    tile.putalpha(alpha)
    for size in [32, 128, 192, 512]:
        tile.resize((size, size), Image.Resampling.LANCZOS).save(
            ROOT / f"public/icon-{size}x{size}.png"
        )
    for size in [192, 512]:
        maskable = Image.new("RGBA", (size, size), "white")
        body = round(size * 0.72)
        maskable.alpha_composite(source.resize((body, body), Image.Resampling.LANCZOS),
                                 ((size - body) // 2, (size - body) // 2))
        maskable.save(ROOT / f"public/icon-maskable-{size}x{size}.png")
    tile.save(ROOT / "src/app/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["pnpm", "tauri", "icon", str(ICONS / "icon.svg"), "-o", tmp],
                       cwd=ROOT, check=True, capture_output=True)
        for name in ["icon.ico", "icon.png", "32x32.png", "64x64.png", "128x128.png",
                     "128x128@2x.png", "StoreLogo.png"] + [
                         f"Square{size}x{size}Logo.png"
                         for size in [30, 44, 71, 89, 107, 142, 150, 284, 310]]:
            shutil.copyfile(Path(tmp) / name, ICONS / name)
    for script in ["macos-icon.gen.py", "tray-icon-template.gen.py"]:
        subprocess.run([sys.executable, str(ICONS / script)], cwd=ROOT, check=True)
    print("蜜蜂品牌图标已生成：网页、PWA、favicon、桌面和托盘")


if __name__ == "__main__":
    main()
