"""アプリのアイコン（build/icon.png、1024px）を作る。

角丸の四角に濃い地の色、明るい色の2文字（Ko）。小さく表示されても読めるよう、字は太く大きく。
使い方: python scripts/make-icon.py [出力先] [地の色] [字の色] [フォント]
"""
import sys
from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
SCALE = 4  # 縁をなめらかにするため、4倍で描いて縮める


def make(out: str, bg: str, fg: str, font_path: str, text: str = "Ko") -> None:
    s = SIZE * SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 角丸の四角（余白を少し取る。OS がアイコンを並べたときに詰まって見えないように）。
    m = int(s * 0.06)
    r = int(s * 0.19)
    d.rounded_rectangle([m, m, s - m, s - m], radius=r, fill=bg)
    # 字の色で、内側に細い縁取り。
    inset = int(s * 0.035)
    d.rounded_rectangle([m + inset, m + inset, s - m - inset, s - m - inset], radius=r - inset, outline=fg, width=int(s * 0.012))
    # 2文字を、真ん中より少し左下に（Adobe の製品のアイコンと同じ置き方）。
    font = ImageFont.truetype(font_path, int(s * 0.42))
    box = d.textbbox((0, 0), text, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    x = (s - w) / 2 - box[0] - s * 0.01
    y = (s - h) / 2 - box[1] + s * 0.03
    d.text((x, y), text, font=font, fill=fg)
    img.resize((SIZE, SIZE), Image.LANCZOS).save(out)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "build/icon.png"
    bg = sys.argv[2] if len(sys.argv) > 2 else "#0e2a24"
    fg = sys.argv[3] if len(sys.argv) > 3 else "#5fe3b5"
    font = sys.argv[4] if len(sys.argv) > 4 else "C:/Windows/Fonts/seguisb.ttf"
    make(out, bg, fg, font)
