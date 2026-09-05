import { loadReleaseManifest } from "@/lib/release-manifest";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const release = await loadReleaseManifest(config.root);
  return Response.json({ release }, {
    headers: { "Cache-Control": "no-store" },
  });
}
