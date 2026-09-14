# LINE rich menus

The relay gives each LINE user one of two rich menus and finds them by name prefix:

- **console** (2500x1686, 4 columns x 2 rows), for people bound to an agent: `/status`, `/a` (opens the keyboard with
  `/a ` filled in), `/pause`, `/resume`, `/quota`, `/help`, the guide, and the guide's `#start` section.
- **onboard** (2500x843, 4 columns x 1 row), for everyone else, installed as the default menu: `/setup`, `/help`,
  the guide, the privacy page.

## Requirements

- Python 3 and [Pillow](https://pypi.org/project/Pillow/) (`python3 -m pip install Pillow`).
- Fonts. On Windows, Microsoft JhengHei and Consolas are found on their own; on macOS and Linux a few common paths
  (PingFang / STHeiti / Menlo, Noto Sans CJK / DejaVu Sans Mono) are tried. Otherwise pass `--font`, `--font-bold`
  and `--mono` with font files. `--lang zh-TW` needs a font with CJK glyphs.
- Node 18+ and a `.env.line` with the channel's credentials for the install step (see the header of
  `scripts/line-app.mjs`).

## 1. Generate

```bash
python3 tools/richmenu/make_richmenu.py --out <dir> \
  --guide https://<relay>/guide --privacy https://<relay>/privacy/ [--lang en]
```

This writes `console.json`, `console.png`, `onboard.json` and `onboard.png` into `<dir>`, which can live outside the
repository. The menu names default to `can2cup-menu-console-v1` and `can2cup-menu-onboard-v1`
(`--console-name` / `--onboard-name`); give a new version a new suffix.

## 2. Install

```bash
node scripts/line-app.mjs menus --dir <dir> --dry-run   # checks the files and prints the plan; calls nothing
node scripts/line-app.mjs menus --dir <dir>
```

The names must start with the prefixes your relay looks for: `LINE_MENU_CONSOLE` / `LINE_MENU_ONBOARD` if it sets
them (pass the same values with `--console-prefix` / `--onboard-prefix`, or put them in `.env.line`), else
`can2cup-menu-console` / `can2cup-menu-onboard`. `menus` refuses files the relay or LINE would not accept (a name
without its prefix, an image that is not PNG/JPEG, over 1 MB, or not the pixel size its JSON declares). It creates
and uploads console, then onboard, makes onboard the default, and only then deletes older menus with either prefix.
