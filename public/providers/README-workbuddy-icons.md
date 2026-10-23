# WorkBuddy provider icons

Official brand marks — not hand-drawn substitutes — in the rounded-rectangle shape
every other provider icon in this directory uses.

| File | Product | Official source |
|---|---|---|
| `workbuddy.png` | WorkBuddy (China, `copilot.tencent.com`) | `https://download.codebuddy.cn/web/website/a5b2fb510f0e7b156f19d072fae0cd12ae1f2f19/assets/logo.svg` |
| `workbuddy-ai.png` | WorkBuddy AI (`www.workbuddy.ai`) | `https://download.codebuddy.ai/web/workbuddy/2365138d79c29bb1cbce4644f5cbbffd2b561a5c/assets/logo.svg` |

Both URLs are the `logo.svg` referenced by the corresponding product home page.

## How these were produced

The vendor artwork (gradient, white mark, proportions) is used unmodified. Only the
container shape was adjusted, because the published logo is a circle and this repo's
provider icons are rounded squares:

1. Download the official `logo.svg`.
2. Change only the container `rect`'s `rx` from `20` to `2.5` (40-unit viewBox → an
   8px radius at 128px, matching `codebuddy-cn.png`'s alpha profile).
3. Render at 1024px, then LANCZOS-resize to 128×128 RGBA.

The `.svg_rounded` intermediate files are not committed; regenerate them with the
steps above when the vendor republishes the brand (the hash segment in each URL
changes).

Do not recolor, redraw, or substitute a look-alike mark: hue and form are what
distinguish the two channels in the dashboard.
