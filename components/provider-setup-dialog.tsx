"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Check, KeyRound, LoaderCircle, PlugZap, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { ProviderLogo } from "@/components/provider-logo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

// For first-run onboarding, the parent should open this dialog until completion and persist
// onConnected/onSkip in localStorage under metis-onboarding-completed.

type ProviderDefinition = {
  key: string;
  name: string;
  description: string;
  authTypes: string[];
  defaultBaseUrl?: string;
};

type OAuthFlow = {
  id: string;
  status: string;
  authUrl?: string;
  instructions?: string;
  userCode?: string;
  error?: string;
  manualInputRequired?: boolean;
};

const API_KEY_URLS: Record<string, string> = {
  cursor: "https://cursor.com/dashboard/api",
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  google: "https://aistudio.google.com/app/apikey",
  antigravity: "https://aistudio.google.com/app/apikey",
  xai: "https://console.x.ai/",
  openrouter: "https://openrouter.ai/keys",
};

export function ProviderSetupDialog({
  open,
  onOpenChange,
  onConnected,
  onSkip,
  onStartChat,
  embedded = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
  onSkip?: () => void;
  onStartChat?: () => void;
  embedded?: boolean;
}) {
  const [providers, setProviders] = useState<ProviderDefinition[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [oauthFlow, setOauthFlow] = useState<OAuthFlow | null>(null);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [connectionId, setConnectionId] = useState("");
  const [tested, setTested] = useState(false);

  const selected = providers.find((provider) => provider.key === selectedKey);
  const supportsOAuth = selected?.authTypes.includes("oauth") ?? false;
  const supportsApiKey = selected?.authTypes.includes("api_key") ?? false;
  const apiKeyUrl = selected ? API_KEY_URLS[selected.key] : undefined;

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setConnectionId("");
    setTested(false);
    setSecret("");
    setOauthFlow(null);
    setLoading(true);
    setError("");
    void fetch("/api/providers", { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as {
          providers?: ProviderDefinition[];
          error?: string;
        };
        if (!response.ok) throw new Error(data.error || "Could not load providers.");
        const nextProviders = data.providers || [];
        setProviders(nextProviders);
        setSelectedKey((current) => current || nextProviders[0]?.key || "");
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load providers."))
      .finally(() => setLoading(false));
  }, [open]);

  function selectProvider(providerKey: string) {
    setSelectedKey(providerKey);
    setSecret("");
    setOauthFlow(null);
    setError("");
    setStep(1);
  }

  async function connectApiKey() {
    if (!selected || !secret.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerKey: selected.key,
          slug: `${selected.key}-main`,
          label: selected.name,
          authType: "api_key",
          ...(selected.defaultBaseUrl ? { baseUrl: selected.defaultBaseUrl } : {}),
          secret: secret.trim(),
          enabled: true,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        connection?: { id?: string };
      };
      if (!response.ok) throw new Error(data.error || "Could not save provider.");
      setConnectionId(data.connection?.id || "");
      setSecret("");
      onConnected();
      setStep(3);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save provider.");
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    if (!connectionId || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(connectionId)}/test`, { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as { error?: string; detail?: string };
      if (!response.ok) throw new Error(data.error || "Connection test failed.");
      setTested(true);
      toast.success(data.detail || `${selected?.name || "Provider"} is ready`);
      setStep(4);
      onConnected();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Connection test failed.");
    } finally {
      setBusy(false);
    }
  }

  async function connectOAuth() {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    setOauthFlow(null);
    let openedAuthUrl = false;
    try {
      const response = await fetch("/api/providers/oauth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerKey: selected.key,
          slug: `${selected.key}-oauth`,
          label: `${selected.name} OAuth`,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        flow?: OAuthFlow;
        error?: string;
      };
      if (!response.ok || !data.flow) throw new Error(data.error || "Could not start OAuth.");
      setOauthFlow(data.flow);

      for (let attempt = 0; attempt < 600; attempt += 1) {
        const statusResponse = await fetch(
          `/api/providers/oauth/status?flowId=${encodeURIComponent(data.flow.id)}`,
          { cache: "no-store" },
        );
        const statusData = (await statusResponse.json().catch(() => ({}))) as {
          flow?: OAuthFlow;
          error?: string;
        };
        if (!statusResponse.ok || !statusData.flow) {
          throw new Error(statusData.error || "Could not read OAuth status.");
        }
        setOauthFlow(statusData.flow);
        if (statusData.flow.authUrl && !openedAuthUrl) {
          openedAuthUrl = true;
          const popup = window.open(statusData.flow.authUrl, "_blank", "noopener,noreferrer");
          if (!popup) toast.info("Open the authorization link shown in the dialog.");
        }
        if (["completed", "error", "cancelled"].includes(statusData.flow.status)) {
          if (statusData.flow.status !== "completed") {
            throw new Error(statusData.flow.error || "OAuth was not completed.");
          }
          toast.success(`${selected.name} connected`);
          onConnected();
          onOpenChange(false);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
      throw new Error("OAuth login timed out.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "OAuth login failed.");
    } finally {
      setBusy(false);
    }
  }

  const body = (
    <>
        <DialogHeader className={embedded ? "p-0" : undefined}>
        <DialogTitle>{step === 4 ? "You’re ready to chat" : "Add your provider"}</DialogTitle>
          <DialogDescription>
            {step === 4
              ? "Your provider is connected. Choose how you want to continue."
              : "A few quick steps are all it takes to start chatting."}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <LoaderCircle className="mr-2 size-4 animate-spin" /> Loading providers…
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground" aria-label="Provider setup progress">
              {["Provider", supportsApiKey ? "API key" : "Sign in", "Test", "Chat"].map((label, index) => {
                const number = index + 1;
                return (
                  <div key={label} className="flex min-w-0 items-center gap-1.5">
                    <span className={`flex size-5 items-center justify-center rounded-full text-[10px] font-medium ${
                      step >= number ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                    }`}>
                      {step > number ? <Check className="size-3" /> : number}
                    </span>
                    <span className="hidden sm:inline">{label}</span>
                    {number < 4 ? <span className="mx-1 text-border">/</span> : null}
                  </div>
                );
              })}
            </div>
            {step === 1 ? (
            <>
            <div className="grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
              {providers.map((provider) => (
                <button
                  key={provider.key}
                  type="button"
                  onClick={() => selectProvider(provider.key)}
                  className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                    provider.key === selectedKey
                      ? "border-primary bg-primary/10"
                      : "border-border/60 hover:bg-muted/50"
                  }`}
                >
                  <ProviderLogo providerId={provider.key} className="size-6 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{provider.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{provider.description}</span>
                  </span>
                  {provider.key === selectedKey ? <Check className="size-4 text-primary" /> : null}
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2">
 {onSkip ? <Button type="button" variant="ghost" onClick={onSkip}>Skip for now</Button> : null}
              <Button type="button" onClick={() => setStep(2)} disabled={!selected}>
                Continue <ArrowRight className="size-4" />
              </Button>
            </div>
            </>
            ) : null}
            {step === 2 && selected ? (
              <div className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-4">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {supportsApiKey ? <KeyRound className="size-4" /> : <ShieldCheck className="size-4" />} Connect {selected.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {supportsApiKey
                    ? `Paste the API key from ${selected.name}. You can go back and choose another provider at any time.`
                    : `Sign in with OAuth to connect ${selected.name}.`}
                </p>
                {supportsApiKey ? (
                  <Input
                    type="password"
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    placeholder="Paste your API key"
                    autoComplete="off"
                    disabled={busy}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void connectApiKey();
                    }}
                  />
                ) : null}
                {supportsApiKey && apiKeyUrl ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="w-fit"
                    onClick={() => window.open(apiKeyUrl, "_blank", "noopener,noreferrer")}
                  >
                    Get API Key
                  </Button>
                ) : null}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setStep(1)} disabled={busy}>
                    Back
                  </Button>
                  {supportsOAuth ? (
                    <Button type="button" variant="outline" onClick={() => void connectOAuth()} disabled={busy}>
                      <ShieldCheck className="size-4" /> Use OAuth
                    </Button>
                  ) : null}
                  {supportsApiKey ? (
                    <Button type="button" onClick={() => void connectApiKey()} disabled={busy || !secret.trim()}>
                      {busy ? <LoaderCircle className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                      Save & continue
                    </Button>
                  ) : null}
                </div>
                {oauthFlow ? (
                  <div className="space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs">
                    <p>{oauthFlow.instructions || "Complete the authorization in the opened window."}</p>
                    {oauthFlow.authUrl ? <a className="break-all underline" href={oauthFlow.authUrl} target="_blank" rel="noreferrer">{oauthFlow.authUrl}</a> : null}
                    {oauthFlow.userCode ? <p className="font-mono">Code: {oauthFlow.userCode}</p> : null}
                    <p className="text-muted-foreground">Status: {oauthFlow.status}</p>
                  </div>
                ) : null}
              </div>
            ) : null}
            {step === 3 && selected ? (
              <div className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-5">
                <div>
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <PlugZap className="size-4" /> Test your connection
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    We’ll make a quick request to confirm that {selected.name} and your API key work.
                  </p>
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setStep(2)} disabled={busy}>Back</Button>
                  <Button type="button" onClick={() => void testConnection()} disabled={busy || !connectionId}>
                    {busy ? <LoaderCircle className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                    Test it out
                  </Button>
                </div>
              </div>
            ) : null}
            {step === 4 && selected ? (
              <div className="space-y-4 rounded-xl border border-primary/20 bg-primary/[0.06] p-5">
                <div>
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <Check className="size-4 text-primary" /> {selected.name} is connected
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tested ? "Everything looks good. Pick a model and send your first message." : "Your provider is ready."}
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" variant="secondary" onClick={() => {
                    onOpenChange(false);
                    onStartChat?.();
                  }}>
                    Test it out
                  </Button>
                  <Button type="button" onClick={() => {
                    onOpenChange(false);
                    onStartChat?.();
                  }}>
                    New Chat <ArrowRight className="size-4" />
                  </Button>
                </div>
              </div>
            ) : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
        )}
    </>
  );
  if (embedded) {
    if (!open) return null;
    return <div className="space-y-4">{body}</div>;
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" onPointerDownOutside={(event) => event.preventDefault()}>
        {body}
      </DialogContent>
    </Dialog>
  );
}
