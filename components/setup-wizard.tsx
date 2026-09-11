"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowRight, Check, LoaderCircle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { HandsStage } from "@/components/hands-stage";
import { ProviderSetupDialog } from "@/components/provider-setup-dialog";

type OsPlatform = "linux" | "darwin" | "win32";
type OsUser = { username: string; home?: string };
type CreatedUser = { id: string; username: string; isAdmin: boolean };
type Step = "welcome" | "people" | "provider" | "ready";

function platformLabel(platform: OsPlatform) {
  return platform === "win32" ? "Windows user" : platform === "darwin" ? "Mac user" : "Linux user";
}

export function SetupWizard({
  open,
  hasUsers,
  onFinished,
}: {
  open: boolean;
  hasUsers: boolean;
  onFinished: () => void;
}) {
  const [step, setStep] = useState<Step>(hasUsers ? "people" : "welcome");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [osUsername, setOsUsername] = useState("");
  const [platform, setPlatform] = useState<OsPlatform>("linux");
  const [osUsers, setOsUsers] = useState<OsUser[]>([]);
  const [users, setUsers] = useState<CreatedUser[]>([]);
  const [showOsBind, setShowOsBind] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep(hasUsers ? "people" : "welcome");
  }, [open, hasUsers]);

  useEffect(() => {
    if (!open || step !== "people") return;
    void fetch("/api/setup", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as {
          platform?: OsPlatform;
          osUsers?: OsUser[];
          hasUsers?: boolean;
        };
        setPlatform(body.platform || "linux");
        setOsUsers(body.osUsers || []);
      })
      .catch(() => undefined);
    if (hasUsers && users.length === 0) {
      void fetch("/api/admin/users", { cache: "no-store" })
        .then(async (response) => {
          const body = (await response.json().catch(() => ({}))) as { users?: CreatedUser[] };
          if (response.ok) setUsers(body.users || []);
        })
        .catch(() => undefined);
    }
  }, [open, step, hasUsers, users.length]);

  const steps = useMemo(
    () => [
      { id: "welcome" as const, label: "Welcome" },
      { id: "people" as const, label: "People" },
      { id: "provider" as const, label: "Provider" },
      { id: "ready" as const, label: "Ready" },
    ],
    [],
  );
  const stepIndex = steps.findIndex((item) => item.id === step);

  if (!open) return null;

  async function createFirstAdmin(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bootstrap", username, password }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        user?: CreatedUser;
      };
      if (!response.ok) throw new Error(body.error || "Could not create account.");
      const created = { id: body.user?.id || "admin", username: username.trim(), isAdmin: true };
      setUsers([created]);
      setUsername("");
      setPassword("");
      if (osUsername) {
        await fetch("/api/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "os-user", osUsername }),
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create account.");
    } finally {
      setBusy(false);
    }
  }

  async function addPerson(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          isAdmin: makeAdmin,
          osUsername: osUsername.trim() || undefined,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        user?: CreatedUser;
      };
      if (!response.ok) throw new Error(body.error || "Could not create user.");
      setUsers((current) => [
        ...current,
        {
          id: body.user?.id || username,
          username: body.user?.username || username.trim(),
          isAdmin: Boolean(body.user?.isAdmin ?? makeAdmin),
        },
      ]);
      setUsername("");
      setPassword("");
      setMakeAdmin(false);
      setOsUsername("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create user.");
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete" }),
    }).catch(() => undefined);
    onFinished();
  }

  return (
    <HandsStage contentClassName="space-y-8">
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Metis setup</p>
        <h1 className="text-3xl font-semibold tracking-tight">
          {step === "welcome" ? "Welcome to Metis" : step === "people" ? "People on this instance" : step === "provider" ? "Connect a provider" : "Metis is ready"}
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">
          {step === "welcome"
            ? "Create the first people on this instance, then connect a model. This only runs once."
            : step === "people"
              ? "The first account is an admin. Add more people if you want, and toggle admin on any of them."
              : step === "provider"
                ? "Connect at least one model provider so chats can run. You can skip and do this later in Settings."
                : "Your admin session is already signed in. Enter the workspace when you are done."}
        </p>
      </div>
      <ol className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-label="Setup progress">
        {steps.map((item, index) => (
          <li key={item.id} className="flex min-w-0 items-center gap-2">
            <span
              className={`flex size-6 items-center justify-center rounded-full text-[11px] font-medium ${
                index < stepIndex
                  ? "bg-primary text-primary-foreground"
                  : index === stepIndex
                    ? "bg-foreground text-background"
                    : "bg-muted"
              }`}
            >
              {index < stepIndex ? <Check className="size-3" /> : index + 1}
            </span>
            <span className={index === stepIndex ? "text-foreground" : ""}>{item.label}</span>
          </li>
        ))}
      </ol>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {step === "welcome" ? (
        <Button type="button" className="h-11 min-h-11 rounded-xl" onClick={() => setStep("people")}>
          Continue <ArrowRight className="size-4" />
        </Button>
      ) : null}

      {step === "people" ? (
        <div className="grid gap-6">
          {users.length ? (
            <ul className="grid gap-2" aria-label="Created users">
              {users.map((user) => (
                <li key={user.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate font-medium">{user.username}</span>
                  <span className="text-xs text-muted-foreground">{user.isAdmin ? "Admin" : "Member"}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No accounts yet. Create the first admin to continue.</p>
          )}

          <form onSubmit={(event) => void (users.length ? addPerson(event) : createFirstAdmin(event))} className="grid gap-4">
            <label className="grid gap-1 text-sm">
              {users.length ? "Username" : "Admin username"}
              <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus required minLength={3} />
            </label>
            <label className="grid gap-1 text-sm">
              Password
              <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required minLength={8} />
            </label>
            {users.length ? (
              <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
                Admin
                <Switch checked={makeAdmin} onCheckedChange={setMakeAdmin} aria-label="Admin" />
              </label>
            ) : null}
            {users.length ? (
              <button type="button" className="text-left text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => setShowOsBind((current) => !current)}>
                {showOsBind ? "Hide host user" : `Optionally bind a ${platformLabel(platform).toLowerCase()}`}
              </button>
            ) : null}
            {showOsBind && users.length ? (
              <label className="grid gap-1 text-sm">
                {platformLabel(platform)}
                <select
                  className="h-11 rounded-md border border-input bg-background px-2 text-sm"
                  value={osUsername}
                  onChange={(event) => setOsUsername(event.target.value)}
                >
                  <option value="">None</option>
                  {osUsers.map((user) => (
                    <option key={user.username} value={user.username}>
                      {user.username}{user.home ? ` · ${user.home}` : ""}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" className="h-11 min-h-11 rounded-xl" disabled={busy}>
                {busy ? <LoaderCircle className="size-4 animate-spin" /> : users.length ? <><Plus className="size-4" /> Add person</> : <>Create admin <ArrowRight className="size-4" /></>}
              </Button>
              {users.length ? (
                <Button type="button" variant="secondary" className="h-11 min-h-11 rounded-xl" disabled={busy} onClick={() => setStep("provider")}>
                  Continue <ArrowRight className="size-4" />
                </Button>
              ) : null}
            </div>
          </form>
        </div>
      ) : null}

      {step === "provider" ? (
        <div className="grid gap-4">
          <ProviderSetupDialog
            open
            embedded
            onOpenChange={() => undefined}
            onConnected={() => setStep("ready")}
            onStartChat={() => setStep("ready")}
            onSkip={() => setStep("ready")}
          />
        </div>
      ) : null}

      {step === "ready" ? (
        <Button type="button" className="h-11 min-h-11 rounded-xl" onClick={() => void finish()}>
          Enter Metis <ArrowRight className="size-4" />
        </Button>
      ) : null}
    </HandsStage>
  );
}
