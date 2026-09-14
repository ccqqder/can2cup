# -*- coding: utf-8 -*-
"""can2cup LINE rich menus: two menus, and the relay links each person to one of them.
  console (2500x1686, 4x2) - people bound to an agent: /status, /a, /pause, /resume, /quota, /help, the guide, how to connect.
  onboard (2500x843, 4x1)  - everyone else (installed as the default): /setup, /help, the guide, the privacy page.
Writes <out>/console.json, console.png, onboard.json, onboard.png. Install them with
  node scripts/line-app.mjs menus --dir <out>
The relay finds the menus by name prefix (LINE_MENU_CONSOLE / LINE_MENU_ONBOARD, defaults can2cup-menu-console /
can2cup-menu-onboard), so --console-name / --onboard-name must start with those.
Requires Python 3 and Pillow. Icons are plain Pillow geometry; labels need a font with CJK glyphs for --lang zh-TW."""
import argparse
import functools
import json
import os
import re
import sys
from urllib.parse import urlsplit

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("Pillow is required: python3 -m pip install Pillow")

BG = (16, 16, 20)
CARD = (27, 27, 33)
FG = (232, 228, 218)
DIM = (138, 134, 126)
LINE = (52, 52, 60)
ACCENT = (232, 168, 124)

LABELS = {
    "zh-TW": dict(console_bar="選單", onboard_bar="開始", status="狀態", a="跟 agent 說", pause="暫停 agent",
                  resume="恢復 agent", quota="本月額度", help="指令說明", guide="使用指南", bind="怎麼綁定",
                  link="連上我的 AI", what="這能做什麼", privacy="隱私與安全"),
    "en": dict(console_bar="Menu", onboard_bar="Start", status="Status", a="Tell agent", pause="Pause agent",
               resume="Resume agent", quota="Quota", help="Commands", guide="Guide", bind="How to connect",
               link="Connect my AI", what="What it does", privacy="Privacy"),
}

WINDIR = os.environ.get("WINDIR", r"C:\Windows")
FONT_CANDIDATES = {
    "--font": [
        os.path.join(WINDIR, "Fonts", "msjh.ttc"),
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    ],
    "--font-bold": [
        os.path.join(WINDIR, "Fonts", "msjhbd.ttc"),
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
    ],
    "--mono": [
        os.path.join(WINDIR, "Fonts", "consola.ttf"),
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/SFNSMono.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
        "/usr/share/fonts/dejavu-sans-mono-fonts/DejaVuSansMono.ttf",
    ],
}


def resolve_fonts(args):
    given = {"--font": args.font, "--font-bold": args.font_bold, "--mono": args.mono}
    found, missing = {}, []
    for flag, path in given.items():
        if path:
            if not os.path.isfile(path):
                sys.exit(f"{flag} {path}: no such file")
            found[flag] = path
        else:
            found[flag] = next((c for c in FONT_CANDIDATES[flag] if os.path.isfile(c)), None)
            if not found[flag]:
                missing.append(flag)
    if missing:
        sys.exit("no font found for " + ", ".join(missing) + ": pass a font file with each of them "
                 "(--font regular and --font-bold with CJK glyphs, e.g. Noto Sans CJK; --mono a monospace font)")
    return found


@functools.lru_cache(maxsize=None)
def load_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError as err:
        sys.exit(f"cannot open font {path}: {err}")


def fit(d, text, maxw, size, maker, floor=28):
    """Shrink until the text fits the card; at the floor size, shorten it with an ellipsis."""
    while size > floor:
        f = maker(size)
        if d.textlength(text, font=f) <= maxw:
            return text, f
        size -= 2
    f = maker(floor)
    while len(text) > 1 and d.textlength(text, font=f) > maxw:
        text = text[:-2] + "…"
    return text, f


def draw_icon(d, kind, cx, cy, r, w):
    thin = max(3, w - 4)
    if kind == "status":
        d.rounded_rectangle([cx - r, cy - r, cx + r * 0.45, cy + r * 0.15], radius=r // 4, outline=FG, width=w)
        d.rounded_rectangle([cx - r * 0.25, cy - r * 0.35, cx + r, cy + r * 0.75], radius=r // 4, outline=ACCENT, width=w)
    elif kind == "a":
        d.rounded_rectangle([cx - r, cy - r * 0.8, cx + r, cy + r * 0.55], radius=r // 4, outline=FG, width=w)
        d.polygon([(cx - r * 0.35, cy + r * 0.5), (cx - r * 0.05, cy + r * 0.5), (cx - r * 0.45, cy + r * 0.95)], fill=FG)
        d.line([cx - r * 0.55, cy - r * 0.35, cx - r * 0.2, cy - r * 0.1], fill=ACCENT, width=w)
        d.line([cx - r * 0.55, cy + r * 0.15, cx - r * 0.2, cy - r * 0.1], fill=ACCENT, width=w)
        d.line([cx + r * 0.0, cy + r * 0.15, cx + r * 0.55, cy + r * 0.15], fill=ACCENT, width=w)
    elif kind == "pause":
        d.rounded_rectangle([cx - r * 0.55, cy - r * 0.9, cx - r * 0.15, cy + r * 0.9], radius=w, outline=ACCENT, width=w)
        d.rounded_rectangle([cx + r * 0.15, cy - r * 0.9, cx + r * 0.55, cy + r * 0.9], radius=w, outline=ACCENT, width=w)
    elif kind == "resume":
        # centred play triangle: its centroid sits at about -0.08r, which reads as centred
        d.polygon([(cx - r * 0.55, cy - r * 0.9), (cx - r * 0.55, cy + r * 0.9), (cx + r * 0.85, cy)], outline=ACCENT, width=w)
    elif kind == "quota":
        base = cy + r * 0.9
        for i, hgt in enumerate((0.7, 1.6, 1.1)):
            x0 = cx - r + i * r * 0.75
            d.rounded_rectangle([x0, base - r * hgt, x0 + r * 0.45, base], radius=w, outline=FG if i != 1 else ACCENT, width=w)
    elif kind == "link":  # two interlocking rings
        d.rounded_rectangle([cx - r, cy - r * 0.45, cx + r * 0.1, cy + r * 0.45], radius=r // 3, outline=FG, width=w)
        d.rounded_rectangle([cx - r * 0.1, cy - r * 0.45, cx + r, cy + r * 0.45], radius=r // 3, outline=ACCENT, width=w)
    elif kind == "privacy":  # shield with a tick
        top, bot = cy - r, cy + r
        d.polygon([(cx, top), (cx + r * 0.85, top + r * 0.35), (cx + r * 0.6, cy + r * 0.75),
                   (cx, bot), (cx - r * 0.6, cy + r * 0.75), (cx - r * 0.85, top + r * 0.35)],
                  outline=FG, width=w)
        d.line([(cx - r * 0.35, cy), (cx - r * 0.05, cy + r * 0.32), (cx + r * 0.42, cy - r * 0.34)],
               fill=ACCENT, width=w, joint="curve")
    elif kind == "guide":  # open book: left page FG, right page ACCENT, a spine between
        d.polygon([(cx - r, cy - r * 0.5), (cx - r * 0.07, cy - r * 0.78),
                   (cx - r * 0.07, cy + r * 0.66), (cx - r, cy + r * 0.9)], outline=FG, width=w)
        d.polygon([(cx + r, cy - r * 0.5), (cx + r * 0.07, cy - r * 0.78),
                   (cx + r * 0.07, cy + r * 0.66), (cx + r, cy + r * 0.9)], outline=ACCENT, width=w)
        d.line([cx, cy - r * 0.78, cx, cy + r * 0.66], fill=FG, width=thin)
    elif kind == "bind":  # a page over two linked rings: "how to connect your computer"
        d.rounded_rectangle([cx - r, cy - r, cx + r * 0.3, cy + r * 0.42], radius=r // 4, outline=FG, width=w)
        for yy in (-0.62, -0.28, 0.06):
            d.line([cx - r * 0.7, cy + r * yy, cx + r * 0.0, cy + r * yy], fill=FG, width=thin)
        d.rounded_rectangle([cx - r * 0.1, cy + r * 0.52, cx + r * 0.5, cy + r * 0.98], radius=r // 4, outline=ACCENT, width=w)
        d.rounded_rectangle([cx + r * 0.4, cy + r * 0.52, cx + r, cy + r * 0.98], radius=r // 4, outline=ACCENT, width=w)
    # "help" is drawn in build() with the font's "?" glyph


def build(spec, key, out, fonts):
    W, H = spec["size"]
    COLS, ROWS = spec["grid"]
    CW, CH = W // COLS, H // ROWS
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    bold = lambda s: load_font(fonts["--font-bold"], s)
    mono = lambda s: load_font(fonts["--mono"], s)
    PAD, RAD = 30, 44
    areas = []
    for i, (kind, label, action, cmdlabel) in enumerate(spec["cells"]):
        col, row = i % COLS, i // COLS
        x0, y0 = col * CW, row * CH
        x1 = W if col == COLS - 1 else x0 + CW
        y1 = H if row == ROWS - 1 else y0 + CH
        cx, yc = (x0 + x1) // 2, (y0 + y1) // 2
        inner = (x1 - x0) - 2 * PAD - 48  # usable width inside the card, with some air
        d.rounded_rectangle([x0 + PAD, y0 + PAD, x1 - PAD, y1 - PAD], radius=RAD, fill=CARD, outline=LINE, width=2)
        icon_cy = yc - 160
        if kind == "help":  # a circle around the font's "?"
            d.ellipse([cx - 105, icon_cy - 105, cx + 105, icon_cy + 105], outline=FG, width=10)
            d.text((cx, icon_cy - 6), "?", font=bold(150), fill=ACCENT, anchor="mm")
        else:
            draw_icon(d, kind, cx, icon_cy, 100, 10)
        text, f = fit(d, label, inner, 94, bold)
        d.text((cx, yc + 70), text, font=f, fill=FG, anchor="mm")
        text, f = fit(d, cmdlabel, inner, 62, mono)
        d.text((cx, yc + 200), text, font=f, fill=DIM, anchor="mm")
        areas.append({"bounds": {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}, "action": action})
    png = os.path.join(out, f"{key}.png")
    img.save(png, "PNG", optimize=True)
    menu = {"size": {"width": W, "height": H}, "selected": True, "name": spec["name"],
            "chatBarText": spec["bar"], "areas": areas}
    with open(os.path.join(out, f"{key}.json"), "w", encoding="utf8") as fh:
        json.dump(menu, fh, ensure_ascii=False, indent=2)
    size = os.path.getsize(png)
    print(f"{png} {size} bytes" + ("  !! over LINE's 1 MB limit" if size > 1_000_000 else ""))


def short(url):
    return re.sub(r"^https?://", "", url).rstrip("/")


def url_arg(value):
    if not re.match(r"^https?://[^\s/]+", value) or len(value) > 990:
        raise argparse.ArgumentTypeError(f"{value!r}: an http(s) URL of at most 990 characters")
    return value


def name_arg(value):
    if not value or len(value) > 300:
        raise argparse.ArgumentTypeError("a rich menu name is 1-300 characters")
    return value


def main():
    ap = argparse.ArgumentParser(description="Generate can2cup's two LINE rich menus (console + onboard).")
    ap.add_argument("--out", required=True, help="directory for console.json/png and onboard.json/png")
    ap.add_argument("--guide", required=True, type=url_arg, help="the guide page, e.g. https://<relay>/guide")
    ap.add_argument("--privacy", required=True, type=url_arg, help="the privacy page, e.g. https://<relay>/privacy/")
    ap.add_argument("--lang", choices=sorted(LABELS), default="zh-TW", help="label language (default zh-TW)")
    ap.add_argument("--console-name", type=name_arg, default="can2cup-menu-console-v1")
    ap.add_argument("--onboard-name", type=name_arg, default="can2cup-menu-onboard-v1")
    ap.add_argument("--font", help="regular font file (needs CJK glyphs for zh-TW)")
    ap.add_argument("--font-bold", help="bold font file")
    ap.add_argument("--mono", help="monospace font file for the command line under each label")
    args = ap.parse_args()
    fonts = resolve_fonts(args)
    L = LABELS[args.lang]
    guide = args.guide
    start = guide.split("#", 1)[0] + "#start"
    parts = urlsplit(guide)
    segments = [s for s in parts.path.split("/") if s]
    console = dict(name=args.console_name, size=(2500, 1686), grid=(4, 2), bar=L["console_bar"], cells=[
        ("status", L["status"], {"type": "message", "text": "/status"}, "/status"),
        # a bare /a means nothing: openKeyboard puts "/a " in the input box and the person types the rest
        ("a", L["a"], {"type": "postback", "data": "menu:a", "inputOption": "openKeyboard", "fillInText": "/a "}, "/a"),
        ("pause", L["pause"], {"type": "message", "text": "/pause"}, "/pause"),
        ("resume", L["resume"], {"type": "message", "text": "/resume"}, "/resume"),
        ("quota", L["quota"], {"type": "message", "text": "/quota"}, "/quota"),
        ("help", L["help"], {"type": "message", "text": "/help"}, "/help"),
        ("guide", L["guide"], {"type": "uri", "uri": guide}, short(guide)),
        ("bind", L["bind"], {"type": "uri", "uri": start}, (segments[-1] if segments else parts.netloc) + "#start"),
    ])
    onboard = dict(name=args.onboard_name, size=(2500, 843), grid=(4, 1), bar=L["onboard_bar"], cells=[
        ("link", L["link"], {"type": "message", "text": "/setup"}, "/setup"),
        ("help", L["what"], {"type": "message", "text": "/help"}, "/help"),
        ("guide", L["guide"], {"type": "uri", "uri": guide}, short(guide)),
        # for someone not yet connected, the question after "what is this" is who sees their messages
        ("privacy", L["privacy"], {"type": "uri", "uri": args.privacy}, short(args.privacy)),
    ])
    os.makedirs(args.out, exist_ok=True)
    build(console, "console", args.out, fonts)
    build(onboard, "onboard", args.out, fonts)
    print(f"install: node scripts/line-app.mjs menus --dir {args.out} --dry-run   (then without --dry-run)")


if __name__ == "__main__":
    main()
