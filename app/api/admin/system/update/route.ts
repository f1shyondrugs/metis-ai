import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAuthenticatedUserId, isAuthenticated } from "@/lib/auth";
import { config } from "@/lib/config";
import { isHostAdmin } from "@/lib/user-access";
import {
  checkForUpdate,
  type UpdateChannel,
} from "@/lib/github-releases";
import { getUpdateJob, startNativeUpdateJob } from "@/lib/update-job";

const execFileAsync = promisify(execFile);
const DOCKER_INSTALLER_BASE = "https://github.com/f1shyondrugs/metis-ai/releases/download";

function dockerInstallerUrl(tag: string) {
  return `${DOCKER_INSTALLER_BASE}/${encodeURIComponent(tag)}/metis-docker-install.sh`;
}

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
    if (channel === "commits") {
      return Response.json({
        status: "commit-available",
        latestCommit: update.latestCommit,
        commitUrl: update.commitUrl,
        message: "A newer master commit is available. Commit updates are intentionally not auto-built in production; use a development checkout to try them.",
      }, { status: 409 });
    }
    if (config.docker) {
      const installerUrl = dockerInstallerUrl(update.latestTag);
      return Response.json({
        status: "external-installer",
        latestTag: update.latestTag,
        installerUrl,
        installCommand: `curl -fsSL ${installerUrl} -o metis-docker-install.sh && bash metis-docker-install.sh --version ${update.latestTag}`,
        message: "This Docker installation must be upgraded with the verified release installer. Persistent data and the workspace are preserved.",
      });
    }

    const activeSlot = process.env.NEXT_DIST_DIR === ".next-a" ? ".next-a" : ".next-b";
    const inactiveSlot = activeSlot === ".next-a" ? ".next-b" : ".next-a";
    if (action === "activate") {
      const preparedManifest = JSON.parse(await readFile(
        `${config.root}/${inactiveSlot}/release-manifest.json`,
        "utf8",
      )) as { tag?: string };
      if (preparedManifest.tag !== update.latestTag) {
        return Response.json({ error: "The verified release has not been prepared in the inactive slot." }, { status: 409 });
      }
      await execFileAsync("systemctl", [
        "restart",
        "--no-block",
        `${config.serviceName}.service`,
        `${config.serviceName}-worker.service`,
        `${config.serviceName}-mcp.service`,
      ], { timeout: 30_000, maxBuffer: 1 * 1024 * 1024 });
      return Response.json({
        ok: true,
        status: "activating",
        latestTag: update.latestTag,
        message: "The verified release is being activated. The services will restart and health checks will run on the new slot.",
      }, { status: 202 });
    }

    if (!update.release) throw new Error("The selected release channel did not return a stable release.");
    const job = startNativeUpdateJob(config.root, update.release, activeSlot);
    return Response.json({
      ok: true,
      status: "preparing",
      jobId: job.jobId,
      latestTag: update.latestTag,
      message: "Update preparation started in the background. This can take several minutes; you can keep using Metis while it runs.",
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
