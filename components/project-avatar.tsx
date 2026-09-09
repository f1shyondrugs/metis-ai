"use client";

import { Book, Briefcase, Code2, FlaskConical, FolderKanban, Palette, Rocket, Sparkles, type LucideIcon } from "lucide-react";
import { projectLogoSrc } from "@/lib/project-constants";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
 folder: FolderKanban,
 briefcase: Briefcase,
 code: Code2,
 sparkles: Sparkles,
 book: Book,
 flask: FlaskConical,
 rocket: Rocket,
 palette: Palette,
};

export function ProjectIconGlyph({ icon, className }: { icon: string; className?: string }) {
 const Icon = ICONS[icon] || FolderKanban;
 return <Icon className={className} aria-hidden="true" />;
}

export function ProjectAvatar({
 id,
 icon,
 color,
 hasLogo,
 updatedAt,
 size = "sm",
 className,
 label,
}: {
 id: string;
 icon: string;
 color: string;
 hasLogo?: boolean;
 updatedAt?: string;
 size?: "sm" | "md" | "lg";
 className?: string;
 label?: string;
}) {
 const box = size === "lg" ? "size-16" : size === "md" ? "size-10" : "size-6";
 const glyph = size === "lg" ? "size-7" : size === "md" ? "size-4" : "size-3";
 const accessibleName = label?.trim() || "";
 if (hasLogo) {
  return (
   // eslint-disable-next-line @next/next/no-img-element
   <img
    src={projectLogoSrc(id, updatedAt)}
    alt={accessibleName}
    className={cn(box, "shrink-0 rounded-lg object-cover ring-1 ring-black/10", className)}
   />
  );
 }
 return (
  <span
   className={cn(box, "inline-flex shrink-0 items-center justify-center rounded-lg text-white shadow-sm", className)}
   style={{ backgroundColor: color }}
   {...(accessibleName
    ? { role: "img" as const, "aria-label": accessibleName }
    : { "aria-hidden": true })}
  >
   <ProjectIconGlyph icon={icon} className={glyph} />
  </span>
 );
}
