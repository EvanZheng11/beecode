"""从蜜蜂透明原图的 Alpha 生成 macOS 单色托盘模板；需要 Pillow。"""

from pathlib import Path
from PIL import Image, ImageOps


def main():
    icons = Path(__file__).resolve().parent
    source = Image.open(icons / "source/bee1024_logo-notext.png").convert("RGBA")
    alpha = source.getchannel("A")
    alpha = ImageOps.contain(alpha.crop(alpha.getbbox()), (46, 38), Image.Resampling.LANCZOS)
    template = Image.new("RGBA", (52, 44))
    template.paste(Image.new("RGBA", alpha.size, "black"),
                   ((52 - alpha.width) // 2, (44 - alpha.height) // 2), alpha)
    out = icons / "tray-icon-template.png"
    template.save(out)
    print(f"已生成蜜蜂托盘模板：{out}，尺寸 {template.size}")


if __name__ == "__main__":
    main()
