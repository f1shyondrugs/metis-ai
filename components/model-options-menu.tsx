"use client";

import { Check, ChevronDown, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  defaultParamsForModel,
  modelParametersForModel,
} from "@/lib/model-params";
import type {
  ModelInfo,
  ModelParamSelection,
  ModelParameter,
} from "@/components/settings-panel";

function labelFor(param: ModelParameter, value: string) {
  const match = param.values.find((v) => v.value === value);
  if (match?.displayName) return match.displayName;
  if (value === "true") return "On";
  if (value === "false") return "Off";
  return value;
}

type MobileComposerControls = {
  modes: Array<{ id: string; name: string; description?: string }>;
  selectedModeId?: string;
  onModeChange: (modeId: string) => void;
  runtimeMode: string;
  runtimeOptions: Array<{ value: string; label: string }>;
  onRuntimeModeChange: (mode: string) => void;
};

type Props = {
  model: ModelInfo;
  modelParams: ModelParamSelection[];
  onModelParamsChange: (params: ModelParamSelection[]) => void;
  mobileComposerControls?: MobileComposerControls;
  className?: string;
};

export function ModelOptionsMenu({
  model,
  modelParams,
  onModelParamsChange,
  mobileComposerControls,
  className,
}: Props) {
  const parameters = modelParametersForModel(model);
  const defaults = defaultParamsForModel({ ...model, parameters });
  const [mobilePermissionsOpen, setMobilePermissionsOpen] = useState(false);

  function paramValue(id: string): string {
    return modelParams.find((p) => p.id === id)?.value
      ?? defaults.find((p) => p.id === id)?.value
      ?? "";
  }

  function setParam(id: string, value: string) {
    const allowed = new Set(parameters.map((p) => p.id));
    const next = [
      ...modelParams.filter((p) => p.id !== id && allowed.has(p.id)),
      { id, value },
    ].filter((p) => allowed.has(p.id));
    onModelParamsChange(next);
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={mobileComposerControls ? "Chat controls" : "Model options"}
          className={cn(
            "size-7 rounded-full text-muted-foreground opacity-100",
            className,
          )}
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        collisionPadding={16}
        className="max-h-[min(54dvh,24rem)] w-[min(18.5rem,calc(100vw-1.5rem))] max-w-none space-y-2 overflow-y-auto overscroll-contain rounded-2xl border-border/45 p-2 shadow-xl md:max-h-[min(70dvh,32rem)] md:w-72 md:max-w-[calc(100vw-1rem)] md:space-y-4 md:rounded-lg md:p-4 md:shadow-md"
      >
        {mobileComposerControls ? (
          <div className="md:hidden">
            {mobileComposerControls.modes.length ? (
              <div className="mb-2.5 space-y-1.5">
                <p className="px-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/60">Mode</p>
                <div className="flex gap-1 overflow-x-auto pb-0.5">
                  {mobileComposerControls.modes.map((mode) => {
                    const active = mode.id === mobileComposerControls.selectedModeId;
                    return (
                      <button
                        key={mode.id}
                        type="button"
                        aria-pressed={active}
                        className={cn(
                          "h-8 shrink-0 rounded-lg px-2.5 text-xs font-medium transition-colors",
                          active
                            ? "bg-muted text-foreground"
                            : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
                        )}
                        onClick={() => mobileComposerControls.onModeChange(mode.id)}
                        title={mode.description}
                      >
                        {mode.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="rounded-xl bg-muted/15 p-1">
              <button
                type="button"
                aria-expanded={mobilePermissionsOpen}
                className="flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-left transition-colors hover:bg-muted/45"
                onClick={() => setMobilePermissionsOpen((open) => !open)}
              >
                <span className="text-xs text-muted-foreground">Access</span>
                <span className="ml-auto min-w-0 truncate text-xs font-medium text-foreground/90">
                  {mobileComposerControls.runtimeOptions.find((option) => option.value === mobileComposerControls.runtimeMode)?.label}
                </span>
                <ChevronDown
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground transition-transform",
                    mobilePermissionsOpen && "rotate-180",
                  )}
                />
              </button>

              {mobilePermissionsOpen ? (
                <div className="mt-1 overflow-hidden rounded-lg border border-border/50 bg-background/45 p-1">
                  {mobileComposerControls.runtimeOptions.map((option) => {
                    const active = option.value === mobileComposerControls.runtimeMode;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={cn(
                          "flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs transition-colors",
                          active
                            ? "bg-muted/65 font-medium text-foreground"
                            : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                        )}
                        onClick={() => {
                          mobileComposerControls.onRuntimeModeChange(option.value);
                          setMobilePermissionsOpen(false);
                        }}
                      >
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                        {active ? <Check className="size-3.5 shrink-0" /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="hidden items-center justify-between gap-3 md:flex">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{model.displayName}</p>
            <p className="text-xs text-muted-foreground">Model options</p>
          </div>
        </div>

        {mobileComposerControls && parameters.length > 0 ? (
          <div className="flex items-center justify-between border-t border-border/35 px-1 pt-2 md:hidden">
            <span className="text-[11px] font-medium text-muted-foreground">Model settings</span>
            {defaults.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 rounded-md px-2 text-[11px] font-normal text-muted-foreground hover:bg-muted/35"
                onClick={() => onModelParamsChange(defaults)}
              >
                Reset
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-2.5 md:space-y-4">
          {parameters.map((param) => {
            const current = paramValue(param.id);
            const isBool =
              param.values.length === 2 &&
              param.values.some((v) => v.value === "true") &&
              param.values.some((v) => v.value === "false");

            if (isBool) {
              const on = current === "true";
              return (
                <div
                  key={param.id}
                  className="flex min-h-9 items-center justify-between gap-3 rounded-lg px-1 md:min-h-0 md:rounded-none md:px-0"
                >
                  <p className="text-xs text-foreground/90 md:text-sm">{param.displayName || param.id}</p>
                  <Switch
                    checked={on}
                    onCheckedChange={(checked) =>
                      setParam(param.id, checked ? "true" : "false")
                    }
                    aria-label={param.displayName || param.id}
                  />
                </div>
              );
            }

            return (
              <div key={param.id} className="space-y-1.5 md:space-y-2">
                <p className="px-1 text-[11px] text-muted-foreground md:px-0 md:text-sm md:text-foreground">
                  {param.displayName || param.id}
                </p>
                <div
                  className="grid w-full gap-1 rounded-xl bg-muted/25 p-1 md:flex md:flex-wrap md:bg-transparent md:p-0"
                  style={{ gridTemplateColumns: `repeat(${Math.max(1, param.values.length)}, minmax(0, 1fr))` }}
                >
                  {param.values.map((v) => {
                    const active = current === v.value;
                    return (
                      <Button
                        key={v.value}
                        type="button"
                        size="sm"
                        variant="ghost"
                        className={cn(
                          "h-8 min-w-0 rounded-lg border-0 px-2 text-xs font-medium shadow-none md:h-7 md:w-auto md:rounded-full md:px-2.5",
                          active
                            ? "bg-background text-foreground ring-1 ring-border/45 hover:bg-background md:bg-primary md:text-primary-foreground md:ring-0 md:hover:bg-primary/90"
                            : "text-muted-foreground hover:bg-muted/55 hover:text-foreground md:border md:border-border md:bg-background",
                        )}
                        onClick={() => setParam(param.id, v.value)}
                      >
                        <span className="truncate">{labelFor(param, v.value)}</span>
                      </Button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {defaults.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="hidden h-7 px-0 text-xs text-muted-foreground md:inline-flex"
            onClick={() => onModelParamsChange(defaults)}
          >
            Reset defaults
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
