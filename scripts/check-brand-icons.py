"""运行 python3 scripts/check-brand-icons.py，校验品牌图标及平台槽位。"""

import io
import struct
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "src-tauri/icons"


def main():
    sizes = {"icon": 512, "32x32": 32, "64x64": 64, "128x128": 128,
             "128x128@2x": 256, "StoreLogo": 50}
    sizes.update({f"Square{s}x{s}Logo": s for s in [30, 44, 71, 89, 107, 142, 150, 284, 310]})
    for name, size in sizes.items():
        im = Image.open(ICONS / f"{name}.png")
        assert im.size == (size, size), name
        assert im.convert("RGBA").getpixel((size // 2, size // 2))[3] == 255, name
    for size in [32, 128, 192, 512]:
        assert Image.open(ROOT / f"public/icon-{size}x{size}.png").size == (size, size)
    for size in [192, 512]:
        im = Image.open(ROOT / f"public/icon-maskable-{size}x{size}.png").convert("RGBA")
        assert im.getchannel("A").getextrema() == (255, 255)
        # 所有明显非白色像素均需处于半径 40% 的 maskable 安全圆内。
        for y in range(size):
            for x in range(size):
                if min(im.getpixel((x, y))[:3]) < 220:
                    assert (x + 0.5 - size / 2) ** 2 + (y + 0.5 - size / 2) ** 2 <= (size * 0.4) ** 2
    favicon = Image.open(ROOT / "src/app/favicon.ico")
    assert favicon.ico.sizes() == {(16, 16), (32, 32), (48, 48)}
    desktop = Image.open(ICONS / "icon.ico")
    assert {(16, 16), (32, 32), (48, 48), (256, 256)} <= desktop.ico.sizes()
    for icon in [favicon, desktop]:
        for size in icon.ico.sizes():
            assert icon.ico.getimage(size).size == size
    tray = Image.open(ICONS / "tray-icon-template.png")
    assert tray.size == (52, 44)
    assert tray.getchannel("A").getextrema() == (0, 255)
    assert all(pixel[:3] == (0, 0, 0) for pixel in tray.getdata())

    data = (ICONS / "icon.icns").read_bytes()
    assert data[:4] == b"icns" and struct.unpack_from(">I", data, 4)[0] == len(data)
    slots = {}
    offset = 8
    while offset < len(data):
        name, length = struct.unpack_from(">4sI", data, offset)
        assert length >= 8 and offset + length <= len(data)
        slots[name.decode()] = data[offset + 8:offset + length]
        offset += length
    expected = {"ic07": 128, "ic08": 256, "ic09": 512, "ic10": 1024,
                "ic11": 32, "ic12": 64, "ic13": 256, "ic14": 512}
    assert set(slots) == set(expected) | {"is32", "s8mk", "il32", "l8mk"}
    assert list(slots) == sorted(slots)
    for name, size in expected.items():
        im = Image.open(io.BytesIO(slots[name])).convert("RGBA")
        assert im.size == (size, size)
        coverage = sum(im.getpixel((x, size // 2))[3] / 255 for x in range(size))
        assert 0.79 <= coverage / size <= 0.82, (name, coverage)
        if size == 1024:
            assert abs(coverage - 824) <= 2
            assert im.getchannel("A").point(lambda a: 255 if a > 127 else 0).getbbox() == (100, 100, 924, 924)
    print("品牌图标校验通过：PNG 尺寸、maskable 安全圆、ICO 槽位、托盘 Alpha、ICNS 槽位及留白")


if __name__ == "__main__":
    main()
