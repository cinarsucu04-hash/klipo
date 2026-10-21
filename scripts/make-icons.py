"""Klipo ikonlarını üretir (Pillow gerekir):  python3 scripts/make-icons.py
Çıktılar: public/icons/*  ve  android/app/src/main/res/mipmap-*  (varsa)"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
C1, C2, LIME = (139, 92, 246), (255, 61, 129), (200, 255, 77)
SS = 4  # süper örnekleme (kenar yumuşatma)


def gradient(n):
    img = Image.new("RGB", (n, n))
    px = img.load()
    for y in range(n):
        for x in range(n):
            t = (x + y) / (2 * (n - 1))
            px[x, y] = tuple(int(C1[i] + (C2[i] - C1[i]) * t) for i in range(3))
    return img


def glyph(draw, n, scale=1.0):
    """Çubuk + oynat üçgeni + kayıt noktası. scale<1 → maskable güvenli alan."""
    def P(x, y):
        return (n * (0.5 + (x - 0.5) * scale), n * (0.5 + (y - 0.5) * scale))
    w = (255, 255, 255)
    # dikey çubuk
    r = 0.045
    x0, y0 = P(0.30, 0.25)
    x1, y1 = P(0.40, 0.75)
    draw.rounded_rectangle([x0, y0, x1, y1], radius=n * r * scale, fill=w)
    # oynat üçgeni: içe küçültülmüş üçgen + köşe daireleri + kalın kenarlar = yuvarlatılmış üçgen
    pts = [P(0.47, 0.27), P(0.77, 0.50), P(0.47, 0.73)]
    r = n * 0.035 * scale
    cx_ = sum(p[0] for p in pts) / 3
    cy_ = sum(p[1] for p in pts) / 3
    a, b, c = [((pts[i][0] - pts[(i + 1) % 3][0]) ** 2 + (pts[i][1] - pts[(i + 1) % 3][1]) ** 2) ** 0.5 for i in range(3)]
    s_ = (a + b + c) / 2
    area = abs((pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) - (pts[2][0] - pts[0][0]) * (pts[1][1] - pts[0][1])) / 2
    k = 1 - r / (area / s_)
    inner = [(cx_ + (x - cx_) * k, cy_ + (y - cy_) * k) for x, y in pts]
    draw.polygon(inner, fill=w)
    for i in range(3):
        x_a, y_a = inner[i]
        x_b, y_b = inner[(i + 1) % 3]
        draw.line([x_a, y_a, x_b, y_b], fill=w, width=int(2 * r))
        draw.ellipse([x_a - r, y_a - r, x_a + r, y_a + r], fill=w)
    # kayıt noktası
    cx, cy = P(0.79, 0.24)
    d = n * 0.05 * scale
    draw.ellipse([cx - d, cy - d, cx + d, cy + d], fill=LIME)


def render(size, kind="any"):
    n = size * SS
    base = gradient(n).convert("RGBA")
    if kind == "any":
        mask = Image.new("L", (n, n), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.225), fill=255)
        base.putalpha(mask)
        glyph(ImageDraw.Draw(base), n, 1.0)
    elif kind == "maskable":
        glyph(ImageDraw.Draw(base), n, 0.66)
    elif kind == "foreground":  # adaptive icon ön planı (şeffaf)
        base = Image.new("RGBA", (n, n), (0, 0, 0, 0))
        glyph(ImageDraw.Draw(base), n, 0.60)
    elif kind == "background":
        pass
    return base.resize((size, size), Image.LANCZOS)


def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)
    print("✓", os.path.relpath(path, ROOT))


web = os.path.join(ROOT, "public", "icons")
save(render(192), os.path.join(web, "icon-192.png"))
save(render(512), os.path.join(web, "icon-512.png"))
save(render(512, "maskable"), os.path.join(web, "maskable-512.png"))
save(render(180), os.path.join(web, "apple-touch-icon.png"))
save(render(64), os.path.join(web, "favicon.png"))

res = os.path.join(ROOT, "android", "app", "src", "main", "res")
if os.path.isdir(os.path.join(ROOT, "android", "app")):
    for name, px in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}.items():
        save(render(px), os.path.join(res, f"mipmap-{name}", "ic_launcher.png"))
        save(render(px), os.path.join(res, f"mipmap-{name}", "ic_launcher_round.png"))
    # adaptive icon katmanları (108dp → xxxhdpi 432px)
    save(render(432, "foreground"), os.path.join(res, "drawable-nodpi", "ic_launcher_foreground.png"))
    save(render(432, "background"), os.path.join(res, "drawable-nodpi", "ic_launcher_background.png"))
    save(render(512), os.path.join(ROOT, "android", "play-store-icon.png"))
