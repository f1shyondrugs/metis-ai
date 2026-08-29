---
name: metis-design-director
description: Automatic design-task coordinator distilled from Anthropic Frontend Design, Vercel Web Interface Guidelines, taste-skill, UI/UX Pro Max design-system, and GitHub Web Design Reviewer. Use for UI/UX, frontend styling, redesigns, responsive fixes, visual audits, and any request to make an interface cleaner or less AI-generated.
---

# Metis Design Director

Use this as the first-pass design brain for product UI work. It synthesizes five specialist skills without blindly stacking their aesthetics. The user's explicit brief and the existing product identity always outrank generic taste advice.

## Source bundle

This coordinator was distilled from:

1. `frontend-design` — Anthropic: deliberate visual direction, typography, restraint, anti-template thinking.
2. `web-design-guidelines` — Vercel: interface quality, accessibility, interaction and implementation review.
3. `design-taste-frontend` — taste-skill: anti-slop / anti-AI defaults, brief inference, responsive craft.
4. `design-system` — UI/UX Pro Max: token discipline, semantic colors, component consistency.
5. `web-design-reviewer` — GitHub Awesome Copilot: rendered visual inspection, responsive testing, fix-and-recheck loop.

Read the routed deep-dive skills when the task needs their specialty. Do not apply every rule from every skill if it conflicts with the product or the brief.

## Default product-design stance

For existing applications, preserve identity before inventing a new one. Improve hierarchy through spacing, typography, alignment and information architecture before adding decoration.

Avoid common LLM / "AI UI" tells unless the brief specifically calls for them:

- decorative purple/cyan/green accents with no semantic meaning
- gradients, glow, glassmorphism, mesh backgrounds, or excessive blur as default styling
- every control placed in its own bordered rounded rectangle
- nested cards inside cards, excessive pills, oversized radii, floating capsules
- green for ordinary healthy/available values when neutral text communicates the state
- colored icons simply to make a dashboard feel lively
- centered generic headings plus equal-width feature cards as a default composition
- motion on every hover or continuously animated status ornaments
- too many borders where spacing and type hierarchy would be clearer

Normal state should usually be neutral. Reserve strong color for semantic moments: destructive/error, warning/attention, selected/primary action, or a genuinely meaningful brand accent. A persistent "100% left" quota is normal state, not a celebration state.

## Workflow

### 1. Inspect before styling

For a redesign or fix, inspect the current rendered UI and relevant source first. If a screenshot/reference exists, use it. Identify the actual failure: hierarchy, density, alignment, semantics, responsiveness, color, typography, component shape, or interaction.

### 2. Make a private design read

Infer product type, audience, existing visual language, and the user's requested direction. Keep this reasoning internal unless the user asks for design rationale. Do not interrupt a clear implementation request with a design questionnaire.

### 3. Establish a small token decision

Reuse the existing token system when present. Prefer semantic roles over arbitrary component colors. Before adding a new color, radius, shadow or spacing value, ask whether an existing semantic token can express it.

For restrained product UI, default toward:

- one neutral surface family
- one restrained brand/selection accent at most
- semantic warning/error colors only when needed
- a small radius scale with clear purpose
- very few shadow levels
- consistent spacing increments

### 4. Reduce before adding

When something feels "AI-ish", first remove unnecessary decoration, containers, color, glow, icons, labels, and motion. Then repair hierarchy with typography, spacing and alignment. Do not solve visual noise by adding a new visual treatment.

### 5. Respect component roles

Controls should look interactive; information should not look like a button. Status, quota, metadata and usage readouts should be visually quieter than primary actions. Selected state must be distinguishable without making every unselected item a box.

### 6. Responsive design is a separate composition

Do not merely shrink desktop. Check touch targets, wrapping, control priority, side panels, viewport height, keyboard/safe-area behavior, and information density on mobile. Preserve important state such as model/context/usage without forcing independent boxed controls.

### 7. Visual verification is mandatory for meaningful UI changes

When browser/screenshot tooling is available, inspect the rendered result after implementation at approximately:

- 390 px mobile
- 768 px tablet
- 1440 px desktop

Check overflow, clipping, hierarchy, alignment, touch targets, focus state, and whether the result still looks templated or over-decorated. Perform at least one critique/fix pass before declaring the visual task complete.

## Deep-skill routing

- New visual direction / redesign / styling: read `frontend-design`.
- "Less AI", cleaner, less templated, landing/portfolio-style taste problems: read `design-taste-frontend`.
- Tokens, color roles, typography scales, component consistency: read `design-system`.
- Audit, accessibility, interaction quality, best-practice review: read `web-design-guidelines`.
- Existing rendered UI, screenshot review, responsive/layout defects: read `web-design-reviewer`.

For a broad redesign or "overall make this cleaner" request, use all five after this coordinator, but synthesize them into one coherent product direction rather than five separate aesthetics.
