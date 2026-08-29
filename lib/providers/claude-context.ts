import type { ModelParamSelection } from "@/lib/model-params";
import { getProviderModelDefinition } from "@/lib/providers/registry";
import { contextWindowForSelection } from "@/lib/context-window";

function contextSelection(params?: ReadonlyArray<ModelParamSelection> | null) {
  return params?.find((param) =>
    param.id === "context" || param.id === "contextWindow" || param.id === "context_window",
  )?.value.trim().toLowerCase();
}

/**
 * Claude Code's 1M context is selected by the official model suffix `[1m]`.
 * Keep the UI/model identity stable and translate only at the SDK boundary,
 * matching T3 Code's resolveClaudeApiModelId behavior.
 */
export function resolveClaudeAgentModelId(
  modelId: string,
  params?: ReadonlyArray<ModelParamSelection> | null,
): string {
  if (/\[1m\]$/i.test(modelId)) return modelId;
  const model = getProviderModelDefinition("claude-code", modelId);
  const selected = contextSelection(params)
    || model?.defaultParams?.find((param) => param.id === "contextWindow" || param.id === "context")?.value;
  return selected?.toLowerCase() === "1m" ? `${modelId}[1m]` : modelId;
}

export function resolveClaudeAgentContextWindow(
  modelId: string,
  params?: ReadonlyArray<ModelParamSelection> | null,
): number | undefined {
  const model = getProviderModelDefinition("claude-code", modelId);
  return contextWindowForSelection(model || { id: modelId }, params);
}
