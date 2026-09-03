# Screenshots

Drop the captures here under these exact names — the README already references them.

| File | What to capture |
|------|-----------------|
| `hero-light.png` | Book mode with the file tree and tab bar visible, light theme |
| `hero-dark.png`  | Same framing and same document, dark theme |
| `csv-table.png`  | A Shift_JIS CSV open in Table mode, status bar visible |
| `mermaid.png`    | The "Insert a Mermaid diagram" recipe helper |
| `startup.gif`    | Double-click to a ready editor |

`hero-dark.png` is optional. If it is missing the README falls back to the light
one, so the page still renders.

## Before capturing

- **Set the UI language to English.** The README is English; a Japanese or Chinese
  filter box in the corner makes the set look careless.
- **Close the floating cheat sheet** (the `Markdown View` / `Table View` bubble in
  the bottom-right). It is a help overlay, not part of the UI.
- **Open a real document, not this repository's own README.** A sample Markdown
  file or a source file reads better than the project describing itself.
- **Resize the window to roughly 1280x800.** Captured at 1920 and shown at 820 the
  text is unreadable; the smaller the downscale, the more survives.

## After capturing

- Crop away empty space (the blank columns to the right of a narrow CSV, for example).
- Compress with pngquant or TinyPNG. Aim for **200-400 KB per PNG**, and keep the
  GIF **under 5 MB** — every clone downloads all of it.
- Keep the same window size and document across `hero-light` / `hero-dark`, or the
  light/dark swap will visibly jump.

## Referencing these from outside the repo

Relative paths only resolve on GitHub. For a winget manifest, a blog post, or
anywhere else, use the absolute form:

```
https://raw.githubusercontent.com/pei-jz/jh-editor/master/docs/images/hero-light.png
```
