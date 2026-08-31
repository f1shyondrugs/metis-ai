import { getAuthenticatedUserId, isAuthenticated } from "@/lib/auth";
import { addProjectFile, getProject, listProjectFiles } from "@/lib/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
 if (!(await isAuthenticated(req))) return Response.json({ error: "Unauthorized" }, { status: 401 });
 const ownerId = (await getAuthenticatedUserId(req)) ?? undefined;
 const { id } = await params;
 if (!getProject(id, ownerId)) return Response.json({ error: "Not found" }, { status: 404 });
 return Response.json({ files: listProjectFiles(id, ownerId) });
}

export async function POST(req: Request, { params }: Params) {
 if (!(await isAuthenticated(req))) return Response.json({ error: "Unauthorized" }, { status: 401 });
 const ownerId = (await getAuthenticatedUserId(req)) ?? undefined;
 const { id } = await params;
 if (!getProject(id, ownerId)) return Response.json({ error: "Not found" }, { status: 404 });

 try {
  const contentType = req.headers.get("content-type") || "";
  let name = "";
  let mimeType: string | undefined;
  let text: string | undefined;
  let data: string | undefined;
  let bytes: Buffer | undefined;

  if (contentType.includes("multipart/form-data")) {
   const form = await req.formData();
   const uploaded = form.get("file");
   name = String(form.get("name") || "").trim();
   mimeType = String(form.get("mimeType") || "").trim() || undefined;
   const isBlobLike = uploaded && typeof uploaded === "object" &&
    typeof (uploaded as { arrayBuffer?: unknown }).arrayBuffer === "function";
   if (uploaded instanceof Blob || isBlobLike) {
     const blob = uploaded as Blob & { name?: string; type?: string };
     if (!name) name = String(blob.name || "").trim();
     if (!mimeType) mimeType = blob.type || undefined;
     bytes = Buffer.from(await blob.arrayBuffer());
   }
  } else {
   const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    mimeType?: string;
    text?: string;
    data?: string;
   };
   name = body.name?.trim() || "";
   mimeType = body.mimeType;
   text = body.text;
   data = body.data;
  }

  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  const file = addProjectFile({
   projectId: id,
   ownerId,
   name,
   mimeType,
   text,
   data,
   bytes,
  });
  if (!file) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ file }, { status: 201 });
 } catch (error) {
  return Response.json({ error: error instanceof Error ? error.message : "Could not add file" }, { status: 400 });
 }
}
