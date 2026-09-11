# Metis Glassmorphism Design Direction

> **Status (11 Sep 2026): superseded.** Glass, glow, and `hsl(var(` are **not** the live UI target. Keep this file as historical context. Current product UI follows the in-app design-director / no-glass rules. Open engineering issues: [PRODUCTION-AUDIT.md](./PRODUCTION-AUDIT.md).

## Goal

Integrate a restrained glassmorphism layer into the existing Metis interface. Preserve the current information architecture, layout, spacing, accessibility, and interaction patterns. This is a visual refinement, not a redesign of the product structure.

## Visual Language

- Use a dark neutral base: near-black graphite backgrounds with subtle cool-blue accents.
- Use glass surfaces sparingly for panels, sheets, dialogs, tool cards, browser chrome, and the composer.
- Glass surfaces should combine:
  - `background: rgba(18, 24, 30, 0.62-0.82)`
  - `backdrop-filter: blur(18-28px) saturate(115-130%)`
  - `border: 1px solid rgba(210, 240, 248, 0.12-0.22)`
  - soft shadow, never a heavy glow
- Keep main content areas readable and stable; do not make every element translucent.
- Avoid gradients, decorative blobs, excessive glow, neon colors, and layered cards inside cards.

## Accent System

- Primary accent: pale cyan / ice blue.
- Secondary accent: muted teal.
- Success: cool green.
- Warning: soft amber.
- Error: restrained coral red.
- Accent colors are for focus, active states, progress, links, browser cursor highlights, and important actions.
- Keep text primarily white, cool gray, and muted gray.

## Components

- Sidebar: darker glass with clear active-chat contrast.
- Topbar: translucent, low-contrast glass.
- Chat messages: mostly solid readable surfaces; use glass only for assistant/tool metadata.
- Composer: strongest glass surface, clear focus ring, stable height.
- Dialogs and sheets: opaque enough for legibility, with blur and thin borders.
- Tool cards: compact glass panels with clear status colors.
- Workspace panels: darker glass frame, solid editor content.
- Browser cursor: dark translucent glass arrow with a bright refractive edge and restrained motion.
- Buttons: solid accent for primary actions; glass/outline for secondary actions.

## Motion

- Use short, calm transitions: 120-220ms.
- Animate opacity, transform, border, and shadow only.
- Cursor movement should ease smoothly; avoid continuous floating or bouncing.
- Click feedback may use one subtle expanding ring.
- Respect `prefers-reduced-motion`.

## Constraints

- Maintain WCAG-compliant contrast.
- Keep focus states visible on every interactive element.
- Preserve responsive behavior across desktop and mobile.
- Use existing components, tokens, icons, and layout primitives.
- Do not introduce new navigation, new features, or marketing-style hero sections.
