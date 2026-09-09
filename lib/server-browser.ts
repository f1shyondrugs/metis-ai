import dns from "node:dns/promises";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Frame, type Locator, type Page } from "playwright";
import { config } from "@/lib/config";
import { getUserAgentCwd } from "@/lib/mcp";
import { isPrivateAddress } from "@/lib/url-security";

const MAX_SNAPSHOT_LENGTH = 120_000;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_TABS = 12;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

type BrowserContextState = {
  ownerId: string;
  chatId: string;
  context: BrowserContext;
  tabs: Map<string, Page>;
  activeTabId: string;
  lastUsed: number;
};

type BrowserAction = {
  action: string;
  sessionId?: string;
  tabId?: string;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  value?: string;
  targetSelector?: string;
  filePath?: string;
  x?: number;
  y?: number;
  deltaY?: number;
  width?: number;
  height?: number;
  downloadPath?: string;
  exact?: boolean;
  timeoutMs?: number;
  includeScreenshot?: boolean;
  includeSnapshot?: boolean;
  steps?: BrowserAction[];
  frame?: string;
  source?: "agent" | "user";
  internalFast?: boolean;
};

type BrowserFormControl = {
  index: number;
  tag: string;
  type?: string;
  role?: string;
  id?: string;
  name?: string;
  selector?: string;
  label?: string;
  placeholder?: string;
  ariaLabel?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  options?: Array<{ value: string; text: string; selected: boolean }>;
  frame?: string;
  frameUrl?: string;
};

type BrowserResult = {
  sessionId: string;
  tabId: string;
  activeTabId: string;
  url: string;
  title: string;
  tabs: Array<{ id: string; url: string; title: string; favicon?: string }>;
  screenshot?: string;
  snapshot?: string;
  viewport: { width: number; height: number };
  downloadPath?: string;
  downloadFilename?: string;
  form?: { text: string; controls: BrowserFormControl[] };
  batch?: Array<{ index: number; action: string; ok: boolean; error?: string }>;
};

export type PointerKind = "click" | "drag" | "hover" | "type" | "scroll";

export type BrowserEventSource = "agent" | "user" | "background";

export type BrowserEventPayload = {
  type: "action" | "navigation" | "screenshot" | "pointer";
  source: BrowserEventSource;
  ownerId: string;
  chatId: string;
  tabId: string;
  url: string;
  title: string;
  action?: string;
  screenshot?: string;
  // Pointer events: viewport-relative FRACTIONS (0..1) so any stream resolution scales.
  x?: number;
  y?: number;
  pointerKind?: PointerKind;
  detail?: string;
  ts: number;
};

const recentBrowserHistory = new Map<string, { url: string; ts: number }>();
const recentOriginAccess = new Map<string, number>();
const pageActivity = new WeakMap<Page, { source: "agent" | "user"; expiresAt: number }>();
const pagePointerPosition = new WeakMap<Page, { x: number; y: number }>();

async function recordBrowserHistory(ownerId: string, chatId: string, tabId: string, url: string, title: string) {
  if (!url || url === "about:blank") return;
  const now = Date.now();
  const key = `${ownerId}:${chatId}:${tabId}`;
  const previous = recentBrowserHistory.get(key);
  // Redirect-heavy applications can emit the same main-frame navigation several
  // times in a few milliseconds. Keep history useful without writing duplicates.
  if (previous?.url === url && now - previous.ts < 2_000) return;
  recentBrowserHistory.set(key, { url, ts: now });
  try {
    const { getDatabase } = await import("@/lib/sqlite");
    getDatabase().prepare("INSERT INTO browser_history (owner_id, chat_id, url, title, ts) VALUES (?, ?, ?, ?, ?)")
      .run(ownerId, chatId, url, title || "", now);
  } catch {
    // history persistence is best-effort, never break navigation
  }
}

function actionSource(action: BrowserAction): "agent" | "user" {
  return action.source === "agent" ? "agent" : "user";
}

function markPageActivity(page: Page, source: "agent" | "user") {
  // Page-driven redirects shortly after an action belong to that action. Later
  // timers/redirects are background activity and must not reopen the UI.
  pageActivity.set(page, { source, expiresAt: Date.now() + 5_000 });
}

function pageEventSource(page: Page): BrowserEventSource {
  const activity = pageActivity.get(page);
  return activity && activity.expiresAt >= Date.now() ? activity.source : "background";
}

async function emitPointerEvent(
  ownerId: string, chatId: string, tabId: string, page: Page,
  kind: PointerKind, detail?: string,
  coords?: { x?: number; y?: number }, selector?: string,
) {
  try {
    let x = coords?.x;
    let y = coords?.y;
    if ((x === undefined || y === undefined) && selector) {
      for (const frame of page.frames()) {
        const locator = frame.locator(selector).first();
        if (!(await locator.count().catch(() => 0))) continue;
        const box = await locator.boundingBox().catch(() => null);
        if (box) {
          x = box.x + box.width / 2;
          y = box.y + box.height / 2;
          break;
        }
      }
    }
    const viewport = page.viewportSize() || DEFAULT_VIEWPORT;
    const previous = pagePointerPosition.get(page);
    if (x === undefined || y === undefined) {
      x = previous?.x ?? viewport.width * 0.5;
      y = previous?.y ?? viewport.height * 0.5;
    }
    x = Math.max(0, Math.min(viewport.width, x));
    y = Math.max(0, Math.min(viewport.height, y));
    pagePointerPosition.set(page, { x, y });
    emitBrowserEvent({
      type: "pointer", source: pageEventSource(page), ownerId, chatId, tabId, url: page.url(), title: "",
      pointerKind: kind, detail,
      x: Math.max(0, Math.min(1, x / viewport.width)),
      y: Math.max(0, Math.min(1, y / viewport.height)),
      ts: Date.now(),
    });
  } catch {
    // pointer overlay is cosmetic — never break the action
  }
}

// The custom server entrypoint (server.mjs via tsx) and the Next-bundled route
// handlers can end up with separate module instances of this file; anchor the
// emitter on globalThis so every consumer observes the same instance.
const browserEventsGlobal = globalThis as typeof globalThis & { __metisBrowserEvents?: EventEmitter };
export const browserEvents: EventEmitter = browserEventsGlobal.__metisBrowserEvents || new EventEmitter();
browserEvents.setMaxListeners(200);
browserEventsGlobal.__metisBrowserEvents = browserEvents;

function emitBrowserEvent(payload: BrowserEventPayload) {
  try {
    browserEvents.emit("browser-event", payload);
  } catch {
    // Event emission must never break the browser action it reports.
  }
}

const pageMeta = new WeakMap<Page, { ownerId: string; chatId: string; tabId: string }>();

const persistentContexts = new Map<string, Promise<BrowserContext>>();
const sessions = new Map<string, BrowserContextState>();
const actionLocks = new Map<string, Promise<void>>();
const allowedAddressCache = new Map<string, { expiresAt: number }>();
const browserProfilesDir = path.join(config.dataDir, "browser-profiles");
const BROWSER_ACTION_QUEUE_TIMEOUT_MS = 90_000;
const BROWSER_ACTION_TIMEOUT_MS = 120_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function envList(name: string) {
  return (process.env[name] || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function sessionKey(ownerId: string, chatId: string) {
  return `${ownerId}:${chatId}`;
}

function isLocalhost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

async function assertAllowedUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid browser URL");
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS browser URLs are allowed");
  }

  const allowedHosts = envList("BROWSER_ALLOWED_HOSTS");
  const hostname = url.hostname.toLowerCase();
  if (!isLocalhost(hostname) && !allowedHosts.includes(hostname)) {
    if (url.protocol !== "https:") throw new Error("External browser targets must use HTTPS");
  }
  if (isLocalhost(hostname)) return url.toString();

  const cached = allowedAddressCache.get(hostname);
  if (!cached || cached.expiresAt <= Date.now()) {
    const addresses = await Promise.race([
      dns.lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Browser DNS lookup timed out")), 5_000)),
    ]);
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error("Browser target resolves to a private or unavailable network address");
    }
    allowedAddressCache.set(hostname, { expiresAt: Date.now() + 60_000 });
  }
  return url.toString();
}

function ownerHash(ownerId: string) {
  return crypto.createHash("sha256").update(ownerId).digest("hex");
}

function profilePath(ownerId: string) {
  return path.join(browserProfilesDir, ownerHash(ownerId));
}

function metadataPath(ownerId: string) {
  return path.join(browserProfilesDir, `${ownerHash(ownerId)}.json`);
}

function readMetadata(ownerId: string): Record<string, { lastAccess: string }> {
  try {
    const value = JSON.parse(fs.readFileSync(metadataPath(ownerId), "utf8")) as unknown;
    return value && typeof value === "object" ? value as Record<string, { lastAccess: string }> : {};
  } catch {
    return {};
  }
}

function writeMetadata(ownerId: string, metadata: Record<string, { lastAccess: string }>) {
  fs.mkdirSync(browserProfilesDir, { recursive: true, mode: 0o700 });
  const target = metadataPath(ownerId);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(metadata)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
  fs.chmodSync(browserProfilesDir, 0o700);
}

function recordOrigin(ownerId: string, rawUrl: string) {
  try {
    const origin = new URL(rawUrl).origin;
    if (origin === "null" || origin === "about:blank") return;
    const accessKey = `${ownerId}:${origin}`;
    const now = Date.now();
    if (now - (recentOriginAccess.get(accessKey) || 0) < 60_000) return;
    recentOriginAccess.set(accessKey, now);
    const metadata = readMetadata(ownerId);
    metadata[origin] = { lastAccess: new Date().toISOString() };
    writeMetadata(ownerId, metadata);
  } catch {
    // Browser navigation validation handles invalid URLs.
  }
}

async function getPersistentContext(ownerId: string) {
  const existing = persistentContexts.get(ownerId);
  if (existing) return existing;
  fs.mkdirSync(browserProfilesDir, { recursive: true, mode: 0o700 });
  const pending = chromium.launchPersistentContext(profilePath(ownerId), {
    headless: true,
    viewport: DEFAULT_VIEWPORT,
  });
  persistentContexts.set(ownerId, pending);
  try {
    const context = await pending;
    fs.chmodSync(profilePath(ownerId), 0o700);
    context.on("close", () => {
      if (persistentContexts.get(ownerId) === pending) persistentContexts.delete(ownerId);
      // A closed context also invalidates every chat session that used it —
      // otherwise those sessions keep queueing actions against a dead pipe.
      for (const [key, state] of sessions) {
        if (state.context === context) sessions.delete(key);
      }
    });
    return context;
  } catch (error) {
    if (persistentContexts.get(ownerId) === pending) persistentContexts.delete(ownerId);
    const message = error instanceof Error ? error.message : String(error);
    if (/Executable doesn't exist/i.test(message)) {
      throw new Error("Playwright Chromium is not installed. From /home/samuel/metis-ai run: pnpm exec playwright install chromium");
    }
    throw error;
  }
}

async function installRequestGuard(page: Page) {
  await page.route("**/*", async (route) => {
    try {
      await assertAllowedUrl(route.request().url());
      await route.continue();
    } catch {
      await route.abort("blockedbyclient");
    }
  });
}

// Tracks a session page so page-initiated navigations (links, redirects,
// JS router pushes) surface as live events even without an explicit action.
function attachPageEventTracking(page: Page, ownerId: string, chatId: string, tabId: string) {
  pageMeta.set(page, { ownerId, chatId, tabId });
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const meta = pageMeta.get(page);
    if (!meta) return;
    const url = frame.url();
    const ts = Date.now();
    void page
      .title()
      .catch(() => "")
      .then((title) => {
        emitBrowserEvent({ type: "navigation", source: pageEventSource(page), ownerId: meta.ownerId, chatId: meta.chatId, tabId: meta.tabId, url, title, ts });
        void recordBrowserHistory(meta.ownerId, meta.chatId, meta.tabId, url, title);
      });
  });
}

async function createSession(ownerId: string, chatId: string) {
  const context = await getPersistentContext(ownerId);
  const page = await context.newPage();
  await installRequestGuard(page);
  attachPageEventTracking(page, ownerId, chatId, "browser-1");
  const state: BrowserContextState = {
    ownerId,
    chatId,
    context,
    tabs: new Map([["browser-1", page]]),
    activeTabId: "browser-1",
    lastUsed: Date.now(),
  };
  sessions.set(sessionKey(ownerId, chatId), state);
  return state;
}

async function getSession(ownerId: string, chatId: string) {
  const key = sessionKey(ownerId, chatId);
  let state = sessions.get(key);
  if (!state) state = await createSession(ownerId, chatId);
  state.lastUsed = Date.now();
  return state;
}

function tabIdFor(state: BrowserContextState, requested?: string) {
  const tabId = requested && state.tabs.has(requested) ? requested : state.activeTabId;
  state.activeTabId = tabId;
  return tabId;
}

function frameUrlLabel(frame: Frame) {
  try {
    const url = new URL(frame.url());
    return `${url.origin}${url.pathname}`;
  } catch {
    return frame.url();
  }
}

function framesFor(page: Page, hint?: string): Frame[] {
  const frames = page.frames();
  const value = String(hint || "").trim();
  if (!value) return frames;
  if (value === "main") return [page.mainFrame()];
  if (/^\d+$/.test(value)) {
    const frame = frames[Number(value)];
    if (!frame) throw new Error(`Browser frame ${value} is no longer available`);
    return [frame];
  }
  const exact = frames.filter((frame) => frame.url() === value);
  if (exact.length) return exact;
  const partial = frames.filter((frame) => frame.url().includes(value));
  if (partial.length) return partial;
  throw new Error(`Browser frame not found: ${value}`);
}

async function findSelectorLocator(page: Page, selector: string, frameHint?: string): Promise<{ frame: Frame; locator: Locator }> {
  for (const frame of framesFor(page, frameHint)) {
    const locator = frame.locator(selector).first();
    if (await locator.count().catch(() => 0)) return { frame, locator };
  }
  throw new Error(`Browser selector not found in page or embedded frames: ${selector}`);
}

async function findTextLocator(page: Page, text: string, exact: boolean, frameHint?: string): Promise<{ frame: Frame; locator: Locator }> {
  for (const frame of framesFor(page, frameHint)) {
    const locator = frame.getByText(text, { exact }).first();
    if (await locator.count().catch(() => 0)) return { frame, locator };
  }
  throw new Error(`Browser text not found in page or embedded frames: ${text.slice(0, 120)}`);
}

async function waitForLocatorAcrossFrames(
  page: Page,
  options: { selector?: string; text?: string; exact?: boolean; frame?: string; timeout: number },
) {
  const candidates = framesFor(page, options.frame).map(async (frame) => {
    const locator = options.selector
      ? frame.locator(options.selector).first()
      : frame.getByText(options.text || "", { exact: options.exact !== false }).first();
    await locator.waitFor({ state: "visible", timeout: options.timeout });
    return { frame, locator };
  });
  try {
    return await Promise.any(candidates);
  } catch {
    throw new Error(options.selector
      ? `Timed out waiting for selector in page or embedded frames: ${options.selector}`
      : `Timed out waiting for text in page or embedded frames: ${(options.text || "").slice(0, 120)}`);
  }
}

async function collectFrameText(page: Page, mode: "text" | "snapshot") {
  const chunks: string[] = [];
  let remaining = MAX_SNAPSHOT_LENGTH;
  const frames = page.frames();
  for (let index = 0; index < frames.length && remaining > 0; index += 1) {
    const frame = frames[index];
    const text = mode === "snapshot"
      ? await frame.locator("body").ariaSnapshot().catch(() => frame.locator("body").innerText().catch(() => ""))
      : await frame.locator("body").innerText().catch(() => "");
    const clean = text.trim();
    if (!clean) continue;
    const header = frames.length > 1 ? `--- frame ${index}: ${frameUrlLabel(frame)} ---\n` : "";
    const chunk = `${header}${clean}`.slice(0, remaining);
    chunks.push(chunk);
    remaining -= chunk.length + 2;
  }
  return chunks.join("\n\n").slice(0, MAX_SNAPSHOT_LENGTH);
}

const BROWSER_FORM_STATE_EXPRESSION = String.raw`(() => {
  const cssPath = (element) => {
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement && parts.length < 7) {
      let part = current.tagName.toLowerCase();
      const name = current.getAttribute('name');
      if (name) {
        part += '[name="' + CSS.escape(name) + '"]';
        parts.unshift(part);
        break;
      }
      const parentElement = current.parentElement;
      if (parentElement) {
        const sameTag = Array.from(parentElement.children).filter((child) => child.tagName === current.tagName);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = parentElement;
      if (current === document.body) {
        parts.unshift('body');
        break;
      }
    }
    return parts.join(' > ');
  };
  const elements = Array.from(document.querySelectorAll(
    'input, textarea, select, button, a[href], [role="radio"], [role="checkbox"], [role="button"], [contenteditable="true"], [draggable="true"], [tabindex]:not([tabindex="-1"])'
  )).slice(0, 500);
  return {
    text: (document.body && document.body.innerText || '').slice(0, 60000),
    controls: elements.map((element) => {
      const id = element.id || undefined;
      const name = element.name || undefined;
      const closestLabel = element.closest('label') && element.closest('label').innerText.trim() || undefined;
      const explicitLabel = id
        ? (document.querySelector('label[for="' + CSS.escape(id) + '"]')?.innerText || '').trim() || undefined
        : undefined;
      const options = element instanceof HTMLSelectElement
        ? Array.from(element.options).map((option) => ({ value: option.value, text: option.text, selected: option.selected }))
        : undefined;
      return {
        tag: element.tagName.toLowerCase(),
        type: element.type || undefined,
        role: element.getAttribute('role') || undefined,
        id,
        name,
        selector: cssPath(element),
        label: explicitLabel || closestLabel || (element.innerText || '').trim().slice(0, 500) || undefined,
        placeholder: element.placeholder || undefined,
        ariaLabel: element.getAttribute('aria-label') || undefined,
        value: 'value' in element ? String(element.value ?? '') : undefined,
        checked: typeof element.checked === 'boolean' ? element.checked : undefined,
        disabled: 'disabled' in element ? Boolean(element.disabled) : undefined,
        options,
      };
    }),
  };
})()`;

async function collectFormState(page: Page): Promise<{ text: string; controls: BrowserFormControl[] }> {
  const controls: BrowserFormControl[] = [];
  const textChunks: string[] = [];
  const frames = page.frames();
  for (let frameIndex = 0; frameIndex < frames.length && controls.length < 500; frameIndex += 1) {
    const frame = frames[frameIndex];
    const frameState = await frame.evaluate(BROWSER_FORM_STATE_EXPRESSION).catch(() => ({ text: '', controls: [] })) as {
      text: string;
      controls: Array<Omit<BrowserFormControl, 'index' | 'frame' | 'frameUrl'>>;
    };
    if (frameState.text.trim()) {
      const header = frames.length > 1 ? `--- frame ${frameIndex}: ${frameUrlLabel(frame)} ---\n` : '';
      textChunks.push(`${header}${frameState.text.trim()}`);
    }
    for (const control of frameState.controls) {
      if (controls.length >= 500) break;
      controls.push({
        ...control,
        index: controls.length,
        frame: String(frameIndex),
        frameUrl: frameUrlLabel(frame),
      });
    }
  }
  return { text: textChunks.join('\n\n').slice(0, 60_000), controls };
}

async function screenshotPage(page: Page, options: { type: "png" } | { type: "jpeg"; quality: number }) {
  return page.screenshot({ ...options, timeout: 15_000 });
}

async function pageInfo(state: BrowserContextState, tabId: string) {
  const page = state.tabs.get(tabId)!;
  const url = page.url();
  const faviconHref = await withTimeout(
    page.locator('link[rel~="icon"], link[rel="shortcut icon"]').first().getAttribute("href"),
    5_000,
    "Timed out reading browser page metadata",
  ).catch(() => null);
  let favicon: string | undefined;
  if (faviconHref) {
    try {
      favicon = new URL(faviconHref, url).toString();
    } catch {
      favicon = undefined;
    }
  } else if (url && url !== "about:blank") {
    favicon = `${new URL(url).origin}/favicon.ico`;
  }
  return {
    id: tabId,
    url,
    title: await withTimeout(page.title(), 5_000, "Timed out reading browser page title").catch(() => "New tab"),
    favicon,
  };
}

async function resultFor(state: BrowserContextState, tabId: string): Promise<BrowserResult> {
  const page = state.tabs.get(tabId)!;
  const info = await pageInfo(state, tabId);
  return {
    sessionId: sessionKey(state.ownerId, state.chatId),
    tabId,
    activeTabId: state.activeTabId,
    url: info.url,
    title: info.title,
    tabs: await Promise.all([...state.tabs.keys()].map((id) => pageInfo(state, id))),
    viewport: state.context.pages().find((candidate) => candidate === page)?.viewportSize() || { width: 1280, height: 800 },
  };
}

export async function captureBrowserFrame(
  ownerId: string,
  chatId: string,
  requestedTabId?: string,
  quality = 70,
  includeMetadata = true,
) {
  const state = await getSession(ownerId, chatId);
  const tabId = tabIdFor(state, requestedTabId);
  const page = state.tabs.get(tabId)!;
  const url = page.url();
  const info = includeMetadata
    ? await pageInfo(state, tabId)
    : { id: tabId, url, title: "" };
  return {
    tabId,
    activeTabId: state.activeTabId,
    tabs: includeMetadata
      ? await Promise.all([...state.tabs.keys()].map((id) => pageInfo(state, id)))
      : [],
    url: url === "about:blank" ? "" : url,
    title: info.title,
    viewport: page.viewportSize() || DEFAULT_VIEWPORT,
    data: await screenshotPage(page, { type: "jpeg", quality: Math.max(35, Math.min(90, quality)) }),
  };
}

export async function setBrowserViewport(
  ownerId: string,
  chatId: string,
  width: number,
  height: number,
) {
  const state = await getSession(ownerId, chatId);
  const nextWidth = Math.max(320, Math.min(2560, Math.round(width) || DEFAULT_VIEWPORT.width));
  const nextHeight = Math.max(240, Math.min(1600, Math.round(height) || DEFAULT_VIEWPORT.height));
  await Promise.all(
    [...state.tabs.values()].map((page) => page.setViewportSize({ width: nextWidth, height: nextHeight })),
  );
  return { width: nextWidth, height: nextHeight };
}

async function performBrowserActionUnlocked(ownerId: string, chatId: string, action: BrowserAction): Promise<BrowserResult> {
  if (!ownerId || !chatId) throw new Error("Browser actions require an authenticated user and chat");
  const state = await getSession(ownerId, chatId);
  let tabId: string;
  let page: Page;

  if (action.action === "new_tab") {
    if (state.tabs.size >= MAX_TABS) throw new Error(`A browser session can have at most ${MAX_TABS} tabs`);
    tabId = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    page = await state.context.newPage();
    await installRequestGuard(page);
    attachPageEventTracking(page, ownerId, chatId, tabId);
    state.tabs.set(tabId, page);
    state.activeTabId = tabId;
  } else {
    tabId = tabIdFor(state, action.tabId);
    page = state.tabs.get(tabId)!;
  }
  markPageActivity(page, actionSource(action));

  if (action.action === "batch") {
    const steps = Array.isArray(action.steps) ? action.steps.slice(0, 100) : [];
    if (!steps.length) throw new Error("browser batch requires at least one step");
    const batch: NonNullable<BrowserResult["batch"]> = [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (!step?.action || step.action === "batch") throw new Error(`Invalid browser batch step ${index}`);
      try {
        await performBrowserActionUnlocked(ownerId, chatId, {
          ...step,
          tabId: step.tabId || state.activeTabId,
          includeScreenshot: false,
          includeSnapshot: false,
          source: actionSource(action),
          internalFast: true,
        });
        batch.push({ index, action: step.action, ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Browser batch step failed";
        batch.push({ index, action: step.action, ok: false, error: message });
        const failed = await resultFor(state, state.activeTabId);
        failed.batch = batch;
        if (action.includeSnapshot) {
          const activePage = state.tabs.get(state.activeTabId)!;
          failed.snapshot = await collectFrameText(activePage, "snapshot");
        }
        return failed;
      }
    }
    const completed = await resultFor(state, state.activeTabId);
    completed.batch = batch;
    if (action.includeSnapshot) {
      const activePage = state.tabs.get(state.activeTabId)!;
      completed.snapshot = await collectFrameText(activePage, "snapshot");
    }
    emitBrowserEvent({ type: "action", source: actionSource(action), ownerId, chatId, tabId: completed.tabId, url: completed.url, title: completed.title, action: action.action, ts: Date.now() });
    return completed;
  }

  if (action.action === "close_tab") {
    if (state.tabs.size <= 1) throw new Error("The last browser tab cannot be closed");
    await page.close();
    state.tabs.delete(tabId);
    tabId = [...state.tabs.keys()][0];
    state.activeTabId = tabId;
    page = state.tabs.get(tabId)!;
  } else if (action.action === "select_tab") {
    state.activeTabId = tabId;
  } else if (action.action === "navigate") {
    if (!action.url) throw new Error("A URL is required");
    await page.evaluate(() => window.stop()).catch(() => undefined);
    await page.goto(await assertAllowedUrl(action.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
    recordOrigin(ownerId, page.url());
  } else if (action.action === "back") {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
  } else if (action.action === "forward") {
    await page.goForward({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
  } else if (action.action === "reload") {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  } else if (action.action === "click") {
    const timeout = Math.max(250, Math.min(Number(action.timeoutMs) || 10_000, 30_000));
    if (action.selector) {
      const { locator } = await findSelectorLocator(page, action.selector, action.frame);
      await locator.click({ timeout, noWaitAfter: true });
    } else if (typeof action.text === "string" && action.text.trim()) {
      const { locator } = await findTextLocator(page, action.text, action.exact !== false, action.frame);
      await locator.click({ timeout, noWaitAfter: true });
    } else if (Number.isFinite(action.x) && Number.isFinite(action.y)) await page.mouse.click(action.x!, action.y!);
    else throw new Error("A selector, text, or x/y coordinates are required for click");
    await emitPointerEvent(ownerId, chatId, tabId, page, "click", action.text?.slice(0, 80), { x: action.x, y: action.y }, action.selector);
  } else if (action.action === "type") {
    if (typeof action.text !== "string") throw new Error("Text is required");
    if (action.selector) {
      const { locator: target } = await findSelectorLocator(page, action.selector, action.frame);
      await target.scrollIntoViewIfNeeded();
      await target.fill(action.text);
    } else {
      await page.keyboard.insertText(action.text);
    }
    await emitPointerEvent(ownerId, chatId, tabId, page, "type", action.text.slice(0, 40), undefined, action.selector);
  } else if (action.action === "press") {
    if (!action.key) throw new Error("A key is required");
    await page.keyboard.press(action.key);
  } else if (action.action === "scroll") {
    const deltaY = Number(action.deltaY) || 600;
    if (action.frame) {
      const frame = framesFor(page, action.frame)[0];
      await frame.evaluate((amount) => window.scrollBy(0, amount), deltaY);
    } else {
      await page.mouse.wheel(0, deltaY);
    }
    await emitPointerEvent(ownerId, chatId, tabId, page, "scroll", `Δy ${deltaY}`);
  } else if (action.action === "resize") {
    const width = Math.max(320, Math.min(Number(action.width) || DEFAULT_VIEWPORT.width, 2560));
    const height = Math.max(240, Math.min(Number(action.height) || DEFAULT_VIEWPORT.height, 1600));
    await page.setViewportSize({ width, height });
  } else if (action.action === "drag") {
    if (!action.selector || !action.targetSelector) throw new Error("source selector and target selector are required for drag");
    let source: Locator | null = null;
    let target: Locator | null = null;
    for (const frame of framesFor(page, action.frame)) {
      const candidateSource = frame.locator(action.selector).first();
      const candidateTarget = frame.locator(action.targetSelector).first();
      if (await candidateSource.count().catch(() => 0) && await candidateTarget.count().catch(() => 0)) {
        source = candidateSource;
        target = candidateTarget;
        break;
      }
    }
    if (!source || !target) throw new Error("Drag source and target were not found in the same page frame");
    await source.scrollIntoViewIfNeeded();
    await target.scrollIntoViewIfNeeded();
    await source.dragTo(target, { timeout: 15_000 });
    await emitPointerEvent(ownerId, chatId, tabId, page, "drag", undefined, undefined, action.targetSelector);
  } else if (action.action === "hover") {
    if (!action.selector) throw new Error("A selector is required for hover");
    const { locator } = await findSelectorLocator(page, action.selector, action.frame);
    await locator.hover({ timeout: 10_000 });
    await emitPointerEvent(ownerId, chatId, tabId, page, "hover", undefined, undefined, action.selector);
  } else if (action.action === "select_option") {
    if (!action.selector || typeof action.value !== "string") throw new Error("A selector and value are required for select_option");
    const { locator } = await findSelectorLocator(page, action.selector, action.frame);
    await locator.selectOption(action.value, { timeout: 10_000 });
  } else if (action.action === "wait_for") {
    const timeout = Math.max(250, Math.min(Number(action.timeoutMs) || 5_000, 30_000));
    if (action.selector || (typeof action.text === "string" && action.text.trim())) {
      await waitForLocatorAcrossFrames(page, { selector: action.selector, text: action.text, exact: action.exact, frame: action.frame, timeout });
    } else {
      throw new Error("wait_for requires a selector or text");
    }
  } else if (action.action === "upload_file") {
    if (!action.selector || !action.filePath) throw new Error("A selector and file path are required for upload_file");
    const local = path.resolve(String(action.filePath));
    const workspace = path.resolve(getUserAgentCwd(ownerId));
    const relative = path.relative(workspace, local);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Browser uploads must use a file inside the agent workspace.");
    }
    if (!fs.existsSync(local)) throw new Error(`File not found: ${local}`);
    const { locator } = await findSelectorLocator(page, action.selector, action.frame);
    await locator.setInputFiles(local, { timeout: 15_000 });
  } else if (action.action === "download") {
    if (!action.selector) throw new Error("A selector is required for download");
    const { locator } = await findSelectorLocator(page, action.selector, action.frame);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      locator.click({ timeout: 15_000 }),
    ]);
    const directory = action.downloadPath || process.cwd();
    const filename = await download.suggestedFilename();
    const destination = path.join(directory, filename);
    await download.saveAs(destination);
    const downloadResult = { ...(await resultFor(state, tabId)), downloadPath: destination, downloadFilename: filename };
    emitBrowserEvent({ type: "action", source: actionSource(action), ownerId, chatId, tabId, url: downloadResult.url, title: downloadResult.title, action: action.action, ts: Date.now() });
    return downloadResult;
  }

  if (action.internalFast) {
    const fastResult = {
      sessionId: sessionKey(state.ownerId, state.chatId),
      tabId,
      activeTabId: state.activeTabId,
      url: page.url(),
      title: "",
      tabs: [],
      viewport: page.viewportSize() || DEFAULT_VIEWPORT,
    };
    emitBrowserEvent({
      type: "action", source: actionSource(action), ownerId, chatId, tabId,
      url: fastResult.url, title: "", action: action.action, ts: Date.now(),
    });
    return fastResult;
  }

  recordOrigin(ownerId, page.url());
  const result = await resultFor(state, tabId);
  if (action.action === "form_state") {
    result.form = await collectFormState(page);
  }
  // Direct browser UI calls retain automatic frames. Agent/MCP calls set
  // includeScreenshot=false and request an explicit screenshot only when visual
  // reasoning is actually needed, avoiding base64+JPEG work after every click.
  const SCREENSHOT_ACTIONS = ["screenshot", "navigate", "click", "type", "reload", "back", "forward", "select_tab", "scroll", "resize", "drag", "select_option", "upload_file"];
  if (SCREENSHOT_ACTIONS.includes(action.action) && action.includeScreenshot !== false) {
    result.screenshot = (await screenshotPage(page, { type: "jpeg", quality: 60 })).toString("base64");
  }
  if (action.action === "snapshot") {
    result.snapshot = await collectFrameText(page, "snapshot");
  }
  if (action.action === "extract_text") {
    result.snapshot = await collectFrameText(page, "text");
  }
  if (action.includeSnapshot && !result.snapshot) {
    result.snapshot = await collectFrameText(page, "snapshot");
  }

  emitBrowserEvent({ type: "action", source: actionSource(action), ownerId, chatId, tabId, url: result.url, title: result.title, action: action.action, ts: Date.now() });
  if (result.screenshot) {
    emitBrowserEvent({ type: "screenshot", source: actionSource(action), ownerId, chatId, tabId, url: result.url, title: result.title, screenshot: result.screenshot, ts: Date.now() });
  }
  return result;
}

export async function performBrowserAction(ownerId: string, chatId: string, action: BrowserAction): Promise<BrowserResult> {
  const key = sessionKey(ownerId, chatId);
  const previous = actionLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  actionLocks.set(key, queued);
  await withTimeout(
    previous,
    BROWSER_ACTION_QUEUE_TIMEOUT_MS,
    "A previous browser action exceeded the queue wait limit.",
  );
  try {
    // A killed Chromium (e.g. OOM or external kill) leaves a zombie session:
    // process gone, CDP pipe dead, calls resolving never. Detect that up front
    // and rebuild the session instead of queueing every action behind a corpse.
    const state = sessions.get(key);
    if (state && !isContextAlive(state)) {
      sessions.delete(key);
      void closeBrowserSession(ownerId, chatId).catch(() => undefined);
    }
    return await withTimeout(
      performBrowserActionUnlocked(ownerId, chatId, action),
      BROWSER_ACTION_TIMEOUT_MS,
      "Browser action exceeded the execution time limit.",
    );
  } finally {
    release();
    if (actionLocks.get(key) === queued) actionLocks.delete(key);
  }
}

function isContextAlive(state: BrowserContextState) {
  try {
    const browser = (state.context as unknown as { browser?: () => { isConnected?: () => boolean } | undefined }).browser?.();
    if (browser && typeof browser.isConnected === "function" && !browser.isConnected()) return false;
  } catch {
    // Browser handle already gone — treat as dead.
    return false;
  }
  // Pages belonging to a dead context also fail on access; probe the cheapest call.
  try {
    const page = state.tabs.get(state.activeTabId);
    if (page && page.isClosed()) return false;
  } catch {
    return false;
  }
  return true;
}

export async function closeBrowserSession(ownerId: string, chatId: string) {
  const key = sessionKey(ownerId, chatId);
  const state = sessions.get(key);
  if (!state) return;
  sessions.delete(key);
  await Promise.all([...state.tabs.values()].map((page) => page.close().catch(() => undefined)));
  if (![...sessions.values()].some((candidate) => candidate.ownerId === ownerId)) {
    persistentContexts.delete(ownerId);
    await state.context.close().catch(() => undefined);
  }
}

export async function cleanupBrowserSessions() {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [key, state] of [...sessions.entries()]) {
    if (state.lastUsed >= cutoff) continue;
    sessions.delete(key);
    await Promise.all([...state.tabs.values()].map((page) => page.close().catch(() => undefined)));
  }
  const owners = new Set([...persistentContexts.keys()]);
  for (const ownerId of owners) {
    if ([...sessions.values()].some((state) => state.ownerId === ownerId)) continue;
    const context = await persistentContexts.get(ownerId)?.catch(() => undefined);
    persistentContexts.delete(ownerId);
    await context?.close().catch(() => undefined);
  }
}

export type BrowserStorageCookie = {
  name: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
};

export type BrowserStorageEntry = { key: string; value: string };

export type BrowserStorageOrigin = {
  origin: string;
  storageTypes: string[];
  lastAccess?: string;
  sizeBytes: number;
  cookies: BrowserStorageCookie[];
  localStorage: BrowserStorageEntry[];
  sessionStorage: BrowserStorageEntry[];
};

function storageOriginMatches(rawOrigin: string, hostname: string) {
  try {
    return new URL(rawOrigin).hostname === hostname;
  } catch {
    return false;
  }
}

function cookieSize(cookie: { name: string; value: string; domain: string; path: string }) {
  return Buffer.byteLength(`${cookie.name}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}`, "utf8");
}

async function readPageStorage(page: Page) {
  return page.evaluate(async () => {
    const entries = (storage: Storage) => Array.from({ length: storage.length }, (_, index) => {
      const key = storage.key(index) || "";
      return { key, value: storage.getItem(key) || "" };
    });
    const estimate = navigator.storage?.estimate
      ? await navigator.storage.estimate().catch(() => undefined)
      : undefined;
    return {
      localStorage: entries(localStorage),
      sessionStorage: entries(sessionStorage),
      usage: typeof estimate?.usage === "number" ? estimate.usage : 0,
    };
  });
}

function originForCookie(cookie: { domain: string }, origins: Iterable<string>) {
  const hostname = cookie.domain.replace(/^\\./, "");
  return [...origins].find((candidate) => storageOriginMatches(candidate, hostname)) || `https://${hostname}`;
}

export async function listBrowserStorage(ownerId: string): Promise<BrowserStorageOrigin[]> {
  const context = await getPersistentContext(ownerId);
  const metadata = readMetadata(ownerId);
  const cookies = await context.cookies();
  const origins = new Map<string, BrowserStorageOrigin>();
  for (const [origin, value] of Object.entries(metadata)) {
    origins.set(origin, {
      origin,
      storageTypes: ["persistent profile"],
      lastAccess: value.lastAccess,
      sizeBytes: 0,
      cookies: [],
      localStorage: [],
      sessionStorage: [],
    });
  }
  for (const cookie of cookies) {
    const origin = originForCookie(cookie, [...origins.keys()]);
    const existing = origins.get(origin) || {
      origin,
      storageTypes: [],
      sizeBytes: 0,
      cookies: [],
      localStorage: [],
      sessionStorage: [],
    };
    existing.cookies.push({ name: cookie.name, domain: cookie.domain, path: cookie.path, expires: cookie.expires, size: cookieSize(cookie) });
    if (!existing.storageTypes.includes("cookies")) existing.storageTypes.push("cookies");
    origins.set(origin, existing);
  }
  for (const page of context.pages()) {
    let origin: string;
    try {
      origin = new URL(page.url()).origin;
      if (origin === "null") continue;
    } catch {
      continue;
    }
    const existing = origins.get(origin) || {
      origin,
      storageTypes: [],
      sizeBytes: 0,
      cookies: [],
      localStorage: [],
      sessionStorage: [],
    };
    const pageStorage = await readPageStorage(page).catch(() => null);
    if (!pageStorage) continue;
    existing.localStorage = pageStorage.localStorage;
    existing.sessionStorage = pageStorage.sessionStorage;
    if (existing.localStorage.length && !existing.storageTypes.includes("localStorage")) existing.storageTypes.push("localStorage");
    if (existing.sessionStorage.length && !existing.storageTypes.includes("sessionStorage")) existing.storageTypes.push("sessionStorage");
    const valueBytes = [...existing.localStorage, ...existing.sessionStorage]
      .reduce((total, entry) => total + Buffer.byteLength(entry.key + entry.value, "utf8"), 0);
    existing.sizeBytes = existing.cookies.reduce((total, cookie) => total + cookie.size, 0) + Math.max(valueBytes, pageStorage.usage);
    origins.set(origin, existing);
  }
  for (const existing of origins.values()) {
    if (!existing.sizeBytes) existing.sizeBytes = existing.cookies.reduce((total, cookie) => total + cookie.size, 0);
  }
  return [...origins.values()].sort((a, b) => a.origin.localeCompare(b.origin));
}

export async function createBrowserStorageEntry(
  ownerId: string,
  rawOrigin: string,
  input: { name: string; value: string; type: "cookie" | "localStorage" | "sessionStorage" },
) {
  const origin = new URL(rawOrigin).origin;
  if (!["http:", "https:"].includes(new URL(origin).protocol)) throw new Error("Invalid browser origin");
  const name = input.name.trim();
  if (!name) throw new Error("Storage entry name is required");
  const context = await getPersistentContext(ownerId);
  if (input.type === "cookie") {
    await context.addCookies([{ name, value: input.value, url: origin, path: "/" }]);
  } else {
    const existingPage = context.pages().find((page) => page.url() === origin || page.url().startsWith(`${origin}/`));
    const page = existingPage || await context.newPage();
    if (!existingPage) {
      await installRequestGuard(page);
      await page.goto(await assertAllowedUrl(origin), { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
    }
    await page.evaluate(({ name: key, value, type }) => {
      (type === "localStorage" ? localStorage : sessionStorage).setItem(key, value);
    }, { name, value: input.value, type: input.type });
    // Keep a newly-created origin page available so the next GET can inspect
    // local/session storage values without another navigation.
  }
  const metadata = readMetadata(ownerId);
  metadata[origin] = { lastAccess: new Date().toISOString() };
  writeMetadata(ownerId, metadata);
}

async function closeOwnerContext(ownerId: string) {
  const context = persistentContexts.get(ownerId);
  if (context) await (await context).close().catch(() => undefined);
  persistentContexts.delete(ownerId);
  for (const [key, state] of sessions) {
    if (state.ownerId === ownerId) sessions.delete(key);
  }
}

export async function clearBrowserOrigin(ownerId: string, rawOrigin: string) {
  const origin = new URL(rawOrigin).origin;
  if (!["http:", "https:"].includes(new URL(origin).protocol)) throw new Error("Invalid browser origin");
  const context = await getPersistentContext(ownerId);
  const cookies = await context.cookies();
  for (const cookie of cookies) {
    const cookieOrigin = `https://${cookie.domain.replace(/^\./, "")}`;
    if (cookieOrigin === origin || cookieOrigin === origin.replace(/^https:/, "http:")) {
      await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
    }
  }
  const pages = context.pages();
  let cleanupPage: Page | undefined;
  if (!pages.some((page) => page.url().startsWith(`${origin}/`) || page.url() === origin)) {
    cleanupPage = await context.newPage();
    await installRequestGuard(cleanupPage);
    await cleanupPage.goto(await assertAllowedUrl(origin), { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
  }
  for (const page of [...pages, ...(cleanupPage ? [cleanupPage] : [])]) {
    if (page.url().startsWith(`${origin}/`) || page.url() === origin) {
      await page.evaluate(async () => {
        localStorage.clear();
        sessionStorage.clear();
        for (const registration of await navigator.serviceWorker?.getRegistrations?.() || []) await registration.unregister();
        for (const database of await indexedDB.databases?.() || []) {
          if (database.name) indexedDB.deleteDatabase(database.name);
        }
        if ("caches" in window) {
          for (const key of await caches.keys()) await caches.delete(key);
        }
      }).catch(() => undefined);
    }
  }
  await cleanupPage?.close().catch(() => undefined);
  const metadata = readMetadata(ownerId);
  delete metadata[origin];
  writeMetadata(ownerId, metadata);
}

export async function clearAllBrowserStorage(ownerId: string) {
  await closeOwnerContext(ownerId);
  fs.rmSync(profilePath(ownerId), { recursive: true, force: true });
  fs.rmSync(metadataPath(ownerId), { force: true });
}
