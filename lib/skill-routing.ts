import type { GlobalModelSettings } from "@/lib/store";
import { enabledSkills } from "@/lib/skills";

export const DESIGN_SKILL_IDS = [
  "metis-design-director",
  "frontend-design",
  "design-taste-frontend",
  "design-system",
  "web-design-guidelines",
  "web-design-reviewer",
] as const;

const DIRECT_DESIGN_RE = /\b(?:ui|ux|user interface|oberfl[aä]che|frontend design|web design|design system|design-system|layout|styling|visual design|visuell|typograph(?:y|ie)|palette|theme|theming)\b/i;
const VISUAL_SURFACE_RE = /\b(?:sidebar|sidepanel|panel|composer|button|buttons|modal|dialog|menu|header|navbar|screen|page|seite|website|webapp|app|mobile|handy|responsive|color|colors|colour|farben?|font|schrift|spacing|abst[aä]nd|radius|rounded|boxy|boxi|card|cards|usage|quota)\b/i;
const DESIGN_ACTION_RE = /\b(?:design|redesign|restyle|style|clean|cleaner|polish|modern|professional|pretty|beautiful|fix|fixe|improve|verbesser|change|[aä]nder|remove|entfern|make|mach|mache|looks?|sieht|aussehen|less ai|weniger ai|ai[- ]?(?:look|ish|generated)|templated|template)\b/i;
const REVIEW_RE = /\b(?:review|audit|check|inspect|pr[uü]f|teste?|test|finde?\s+(?:die\s+)?fehler|fehler|broken|kaputt|responsive|screenshot|reference|referenz)\b/i;
const SYSTEM_RE = /\b(?:design system|design-system|token|tokens|theme|theming|palette|color system|farbsystem|typograph(?:y|ie)|spacing scale|component consistency|consistent|consistency|einheitlich)\b/i;
const MAJOR_RE = /\b(?:overall|entire|whole|full|komplett|gesamt|redesign|rework|overhaul|cleaner|professional|less ai|weniger ai|ai[- ]?(?:look|ish|generated)|boxy|boxi|responsive|mobile ui|handy ui|design system|einheitlich)\b/i;
const BUILD_RE = /\b(?:build|create|implement|redesign|restyle|style|fix|fixe|change|[aä]nder|remove|entfern|make|mach|mache|bau|baue|polish|clean|cleaner|verbesser)\b/i;

export function isVisualDesignTask(message: string) {
  const text = message.trim();
  if (!text) return false;
  if (DIRECT_DESIGN_RE.test(text)) return true;
  return VISUAL_SURFACE_RE.test(text) && DESIGN_ACTION_RE.test(text);
}

export function autoSkillActivationPrompt(
  message: string,
  settings?: GlobalModelSettings,
  options: { hasVisualReference?: boolean } = {},
) {
  if (!isVisualDesignTask(message)) return "";

  const available = new Map(enabledSkills(settings).map((skill) => [skill.id, skill]));
  const requested = new Set<string>();
  const add = (id: string) => {
    if (available.has(id)) requested.add(id);
  };

  add("metis-design-director");

  const major = MAJOR_RE.test(message);
  const building = BUILD_RE.test(message);
  const reviewing = REVIEW_RE.test(message) || Boolean(options.hasVisualReference);
  const systemWork = SYSTEM_RE.test(message);

  if (major || building) {
    add("frontend-design");
    add("design-taste-frontend");
  }
  if (major || systemWork) add("design-system");
  if (major || reviewing || building) add("web-design-reviewer");
  if (major || reviewing) add("web-design-guidelines");

  // A tiny UI tweak still gets the coordinator plus one taste pass instead of
  // silently falling back to generic model styling.
  if (requested.size <= 1) {
    add("frontend-design");
    add("design-taste-frontend");
  }

  const skills = [...requested]
    .map((id) => available.get(id))
    .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));
  if (!skills.length) return "";

  return [
    "Automatic skill routing: DESIGN bundle is active for this task only.",
    "Before changing visual UI, read the following SKILL.md files with the filesystem/read_file tool and synthesize them. The user's explicit brief and the existing product identity override generic skill advice:",
    skills.map((skill) => `- ${skill.id}: ${skill.skillPath}`).join("\n"),
    "Do not announce or narrate this routing unless asked. For redesign/fix work, inspect the current rendered UI and source before styling. Prefer hierarchy, spacing, typography and semantic tokens over decorative color, glow, gradients, excessive rounded boxes or other LLM-default visual treatments.",
    "For meaningful UI changes, verify the rendered result at mobile (~390px), tablet (~768px), and desktop (~1440px) when browser/screenshot tooling is available, then perform one critique/fix pass before reporting completion.",
  ].join("\n");
}
