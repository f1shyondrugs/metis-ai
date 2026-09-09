import { getAuthenticatedUser, isAuthenticated } from "@/lib/auth";
import {
  clearAllBrowserStorage,
  clearBrowserOrigin,
  createBrowserStorageEntry,
  listBrowserStorage,
} from "@/lib/server-browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function ownerId(req: Request) {
  const user = await getAuthenticatedUser(req);
  return user?.id || user?.username || null;
}

export async function GET(req: Request) {
  if (!(await isAuthenticated(req))) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const owner = await ownerId(req);
  if (!owner) return Response.json({ error: "Authentication context is required" }, { status: 401 });
  try {
    return Response.json({ origins: await listBrowserStorage(owner) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not list browser storage" }, { status: 400 });
  }
}

export async function POST(req: Request) {
  if (!(await isAuthenticated(req))) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const owner = await ownerId(req);
  if (!owner) return Response.json({ error: "Authentication context is required" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { origin?: unknown; name?: unknown; value?: unknown; type?: unknown };
  if (typeof body.origin !== "string" || !body.origin.trim() || typeof body.name !== "string" || typeof body.value !== "string" || !["cookie", "localStorage", "sessionStorage"].includes(String(body.type))) {
    return Response.json({ error: "Provide origin, name, value, and type (cookie, localStorage, or sessionStorage)" }, { status: 400 });
  }
  try {
    await createBrowserStorageEntry(owner, body.origin, {
      name: body.name,
      value: body.value,
      type: body.type as "cookie" | "localStorage" | "sessionStorage",
    });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not create browser storage entry" }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  if (!(await isAuthenticated(req))) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const owner = await ownerId(req);
  if (!owner) return Response.json({ error: "Authentication context is required" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { origin?: unknown; all?: unknown };
  try {
    if (body.all === true) {
      await clearAllBrowserStorage(owner);
    } else if (typeof body.origin === "string" && body.origin.trim()) {
      await clearBrowserOrigin(owner, body.origin);
    } else {
      return Response.json({ error: "Provide an origin or all=true" }, { status: 400 });
    }
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not clear browser storage" }, { status: 400 });
  }
}
