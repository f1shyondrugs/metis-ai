import { getAuthenticatedUserId, isAuthenticated } from "@/lib/auth";
import { config } from "@/lib/config";
import { isHostAdmin } from "@/lib/user-access";
import {
  checkForUpdate,
  type UpdateChannel,
} from "@/lib/github-releases";
import { getUpdateJob, startInstallerUpdateJob } from "@/lib/update-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1_800;

async function requireHostAdmin(req: Request, message: string) {
  if (!(await isAuthenticated(req))) return { response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  const userId = await getAuthenticatedUserId(req);
  if (!isHostAdmin(userId)) return { response: Response.json({ error: message }, { status: 403 }) };
  return { userId };
}

export async function GET(req: Request) {
  const access = await requireHostAdmin(req, "Only host administrators can check for updates.");
  if ("response" in access) return access.response;
  try {
    const searchParams = new URL(req.url).searchParams;
    const jobId = searchParams.get("job");
    if (jobId) {
      const job = getUpdateJob(jobId);
      if (!job) return Response.json({ error: "Update job not found. It may have expired after a service restart." }, { status: 404 });
      return Response.json(job, { headers: { "Cache-Control": "private, no-store" } });
    }
    const channel: UpdateChannel = searchParams.get("channel") === "commits" ? "commits" : "releases";
    const update = await checkForUpdate(config.root, fetch, channel);
    return Response.json(update, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({
      status: "check-failed",
      error: error instanceof Error ? error.message : "Could not check for updates.",
    }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const access = await requireHostAdmin(req, "Only host administrators can update Metis.");
  if ("response" in access) return access.response;

  let requestedTag: string | undefined;
  let action: "prepare" | "activate" = "prepare";
  let channel: UpdateChannel = "releases";
  try {
    const body = await req.json().catch(() => ({})) as { tag?: unknown; action?: unknown; channel?: unknown };
    if (typeof body.tag === "string") requestedTag = body.tag;
    if (body.action === "activate") action = "activate";
    if (body.channel === "commits") channel = "commits";
  } catch {
    requestedTag = undefined;
  }

  try {
    const update = await checkForUpdate(config.root, fetch, channel);
    if (!update.updateAvailable) {
      return Response.json({
        status: update.status,
        message: update.status === "development"
          ? "This installation is a development build and is not eligible for an automatic stable update."
          : "No newer stable release is available.",
      }, { status: 409 });
    }
    if (requestedTag && requestedTag !== update.latestTag) {
      return Response.json({ error: "The requested release is not the currently verified latest stable release." }, { status: 409 });
    }
    if (channel === "commits" && !update.latestCommit) {
      throw new Error("GitHub did not return a master commit SHA.");
    }
    if (action === "activate") {
      return Response.json({
        ok: true,
        status: "activating",
        latestTag: update.latestTag,
        latestCommit: update.latestCommit,
        message: "Updates now run the installer in one step. If an update is already running, keep this page open.",
      }, { status: 202 });
    }

    const job = await startInstallerUpdateJob({
      root: config.root,
      docker: config.docker,
      channel,
      tag: channel === "releases" ? update.latestTag : undefined,
      commit: update.latestCommit,
      serviceName: config.serviceName,
      dataDir: config.dataDir,
    });
    return Response.json({
      ok: true,
      status: "preparing",
      jobId: job.jobId,
      latestTag: update.latestTag,
      latestCommit: update.latestCommit,
      message: "Installer update started. Metis will show the updating screen until the installer finishes and restarts the services.",
    }, { status: 202 });
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr || "")
      : "";
    return Response.json({
      status: "failed",
      error: `${error instanceof Error ? error.message : "Metis update failed."}${detail ? `: ${detail.slice(-800)}` : ""}`,
    }, { status: 500 });
  }
}
