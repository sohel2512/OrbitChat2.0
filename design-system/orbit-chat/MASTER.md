# Design System Master File — Orbit Chat v3 "Orbit Aurora"

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** Orbit Chat
**Version:** v3 — Orbit Aurora (full visual replacement of v2 Liquid Glass gold)
**Generated:** 2026-11-17
**Widget source:** [Uiverse Galaxy](https://github.com/uiverse-io/galaxy) library (cloned at `skills/uiverse-galaxy/`) — components adapted and retokenized, not copied verbatim.
**Category:** Futuristic premium / aurora glassmorphism

---

## Global Rules

### Color Palette

| Role | Value | Token |
|------|-------|-------|
| Background base | `#06021a` deep space indigo | `--oc-bg0` |
| Background mid | `#0b0630` | `--oc-bg1` |
| Background deep | `#04010f` | `--oc-bg2` |
| Aurora primary | `#8b5cf6` electric violet | `--oc-aur1` |
| Aurora secondary | `#22d3ee` cyan | `--oc-aur2` |
| Aurora accent | `#f472b6` pink | `--oc-aur3` |
| Gradient bridge | `#6366f1` indigo | `--oc-ind` |
| Primary gradient | violet → indigo → cyan (120deg) | `--oc-grad` |
| Hot gradient (self) | pink → violet → cyan | `--oc-grad-hot` |
| Text ink | `#f2f0ff` | `--oc-ink` |
| Text mid | `#bdb8e8` | `--oc-mid` |
| Text dim (≥6:1) | `#948fc7` | `--oc-dim` |
| Glass fill | `rgba(124,108,246,.08)` | `--oc-glass` |
| Panel | `rgba(13,8,40,.72)` | `--oc-panel` |
| Hairline | `rgba(148,130,255,.16)` | `--oc-line-soft` |
| Success / danger | `#34d399` / `#fb7185` | `--oc-ok` / `--oc-bad` |

### Typography

| Role | Font | Notes |
|------|------|-------|
| Display / headings / buttons | **Sora** (400–800) | geometric futuristic, wide letterspacing on labels |
| Body / inputs / messages | **Inter** (400–700) | 14.5–15px, line-height 1.5–1.65 |
| Self-hosting | `next/font/google` | variables `--font-sora`, `--font-inter`, zero CLS |

### Signature elements (all implemented in `src/app/orbit.css`)

1. **Aurora field** — 3 blurred drifting gradient blobs (`--oc-aurora` layer) + static starfield layer on `.orbit-root::after`.
2. **Animated conic border** — join card border cycles violet→cyan→pink via `@property --oc-angle` (static gradient fallback when unsupported).
3. **Springy pill switch** — Uiverse `gharsh11032000` toggle adapted: gradient fill + glow when on, spring `cubic-bezier(.175,.885,.32,1.275)` thumb, 52×30 with ≥44px hit area via padding row. Used for the Haptic feedback setting.
4. **Shine-sweep CTA** — `.oc-connect` gradient button with infinite skewed shine sweep (`oc-btn-shine`) + arrow slide on hover.
5. **Gradient identity bubbles** — self messages: violet→cyan gradient fill, white text, glow shadow; others: neutral glass with violet hairline. Distinct corner radii (6px tail side).
6. **Per-member avatar hues** — violet/indigo, cyan, pink rotation via `nth-child` so member lists read colorful without per-user config.
7. **Orbit loader** — `.oc-spinner` white-top ring spin; gradient bouncing dots for typing (`oc-tdots`).
8. **Aurora hairline** — 1.5px gradient line under the chat header.
9. **Ping presence dot** — green online dot with expanding ring animation.

### Motion tokens

- Ease out `cubic-bezier(.22,1,.36,1)` · spring `cubic-bezier(.34,1.56,.64,1)`
- Fast 160ms · medium 300ms · blob drift 24–30s alternate
- `prefers-reduced-motion`: all ambient animations disabled, transitions collapsed

### Accessibility

- Text contrast ≥ 4.5:1 (`--oc-dim` measured 6.2:1 on bg0)
- Visible focus: cyan `outline: 2px solid` + offset on all interactive elements
- Touch targets ≥ 44px (menu/icon buttons, switch row, inputs 48–54px)
- `role="log"` messages, `aria-live` typing, labelled dialogs and switches

### Responsive

- ≤760px: sidebar becomes spring drawer + blurred scrim; bubbles 88%; clear button icon-only; confirm footer stacks
- 761–1020px: sidebar 240px; >1020px: 280px
