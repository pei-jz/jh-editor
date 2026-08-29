# Theming

How a theme is defined, and how to add one without touching five files.

---

## Adding a theme

Two edits.

**1. `src/modules/utils/Themes.js`** — declare it:

```js
{ id: 'my-theme', label: 'My Theme', dark: true, bootBg: '#101418' },
```

`dark` is not cosmetic. It decides which syntax palette CodeMirror builds,
which Mermaid theme renders, which xterm palette the terminal takes, and — via
`--theme-contrast` — which direction every derived surface moves in. Judge it by
the **editor surface** (`--bg-color`), not by the chrome: Hanging Scroll has
indigo mounting and is `dark: false`, because the sheet you read is pale silk.

**2. `src/styles/themes.css`** — the palette:

```css
body.theme-my-theme {
    --bg-color: #14181d;
    --bg-color-secondary: #1a1f26;
    --sidebar-bg: #12161b;
    --header-bg: #1a1f26;
    --border-color: rgba(255, 255, 255, 0.10);
    --text-color: #d7dde5;
    --primary-color: #6ea8fe;
    --hover-color: #232a33;
}
```

A dark theme also joins the contrast-direction list at the foot of that file:

```css
body.theme-dark,
…
body.theme-my-theme {
    --theme-contrast: #fff;
    …
}
```

Then mirror `bootBg` into the anti-flash script in `index.html`, and add
`'My Theme'` to `src/locales/{ja,zh,ko}.js`.

`npm test` fails if you miss any of it. That is the point of the registry —
every one of those omissions used to fail silently.

---

## Why a registry

Theme knowledge used to live in five places:

| Where | What it held | How it failed |
|-------|--------------|---------------|
| `themes.css` | the palette | — |
| `ThemeInfo.js` | the dark list | light syntax on a dark sheet, ~1.4:1 |
| `SettingsModal.applyTheme` | the class-removal list | two theme classes on `<body>`; palette decided by stylesheet order |
| `index.html` | `<option>` + anti-flash colour | theme missing from the picker; white flash on launch |
| `locales/*.js` | the visible name | English name in a Japanese UI |

None of them threw. `Themes.js` is now the source: the picker is built from it,
`applyTheme` derives its removal list from it, `isDarkTheme()` reads it, and
`tests/ThemePalettes.test.js` checks the CSS, the boot script and the
dictionaries against it.

---

## Derived tokens

A theme declares **eight colours and a direction**. Everything else is computed
in `themes.css` under `DERIVED TOKENS`:

| Token | Use |
|-------|-----|
| `--surface-raised` / `--surface-sunken` | a panel above / a well below the page |
| `--overlay-bg` `--overlay-border` `--overlay-shadow` | floating panels, docks, popovers |
| `--scrim` | the dimmer behind a modal |
| `--text-muted` `--text-faint` | secondary and tertiary text |
| `--text-on-primary` | text on an accent fill |
| `--primary-soft` `--primary-soft-strong` `--primary-border` | tinted accent surfaces |
| `--success-color` `--warning-color` `--danger-color` (+ `-soft`) | status, kept separate from the accent |
| `--control-bg` `--control-border` `--divider-color` | inputs, buttons, rules |

They are built with `color-mix()` against `--theme-contrast`, which is `#fff` on
dark themes and `#000` on light ones. So "slightly raised" means *lighter* on a
dark theme and *darker* on a light one, from one declaration.

### They are declared on `body`, and that is load-bearing

Custom properties resolve **where they are declared**. A derived token written
on `:root` substitutes the `:root` palette and inherits *that resolved value*
downward — so every theme, whose overrides land on `body.theme-x`, would
silently get the light surfaces. Declaring them on `body` means they substitute
the same element's themed palette. A test pins this.

---

## Writing a themeable component

**Never write a literal colour outside `themes.css`.** A literal is a colour
that stays the same on all eleven themes; it looks correct on the one it was
written against and wrong on the other ten.

```css
/* No */
background: rgba(30, 30, 35, 0.7);
color: #e0e0e0;
border: 1px solid rgba(255, 255, 255, 0.1);

/* Yes */
background: var(--overlay-bg);
color: var(--text-color);
border: 1px solid var(--overlay-border);
```

Two literals are legitimate:

- **A fallback inside `var()`** — `var(--danger-color, #dc3545)` only shows if
  the token is missing.
- **A component that is deliberately one look on every theme.** The image
  lightbox is a dark scrim with a white mat, the way every lightbox is; it is
  not tracking the theme on purpose.

For inline styles built in JS, `var()` works there too:

```js
el.style.cssText = 'background:var(--primary-soft);border:1px solid var(--primary-border);';
```

---

## What is still hard-coded

The conversion has covered the overlays that were visibly wrong — Inline AI, the
AI activity dock, the task panel's status colours, toasts. A scan still reports
roughly 500 literals elsewhere, most of them in `editor.css`, `diff.css`,
`structure.css` and `explorer.css`.

They are worth working through in this order:

1. **Anything that floats** — panels, popovers, docks. Wrong here is most
   visible, because it sits over content that IS themed.
2. **Status colours** — map to `--success/--warning/--danger`, so a theme can
   tune them for its own contrast.
3. **Accent tints** — every `rgba(10, 108, 255, …)` is the default accent
   frozen; `--primary-soft` and friends replace them.
4. **The rest**, opportunistically, when a file is being edited anyway.

A scan is in `tests/` territory rather than a script: if you want the current
count, grep for hex and `rgb(` outside `themes.css` and subtract the `var()`
fallbacks.

---

## Growth

`themes.css` is ~1,400 lines for eleven themes and will keep growing, but not
linearly: the derived layer means a new theme adds a palette block (~10 lines)
rather than a full set of surface, text and state rules.

If it does become unwieldy, the split to make is **one file per theme**
(`src/styles/themes/nord.css`) imported from an index — the same move already
made for the locale dictionaries, and for the same reason: a translation edit
and a code edit should not collide in one file. Do it when the file is genuinely
in the way, not before; a directory of eleven small files has its own cost.
