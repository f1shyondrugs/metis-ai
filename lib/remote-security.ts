export type RemotePermissionMode = "user" | "admin";
export type RemoteCapability =
  | "user_files"
  | "user_processes"
  | "user_directories"
  | "system_files"
  | "services"
  | "disks"
  | "admin_processes";

export const USER_CAPABILITIES: RemoteCapability[] = ["user_files", "user_processes", "user_directories"];
export const ADMIN_CAPABILITIES: RemoteCapability[] = [...USER_CAPABILITIES, "system_files", "services", "disks", "admin_processes"];

export function normalizePermissionMode(value: unknown): RemotePermissionMode {
  return value === "admin" ? "admin" : "user";
}

export function capabilitiesForPermissionMode(mode: RemotePermissionMode) {
  return mode === "admin" ? [...ADMIN_CAPABILITIES] : [...USER_CAPABILITIES];
}

const SYSTEM_COMMANDS = /(^|[\\s;&|])(sc|sc\.exe|net\s+(start|stop)|powershell(?:\.exe)?|pwsh|reg(?:\.exe)?|diskpart|mountvol|format(?:\.com)?|bcdedit|wevtutil|takeown|icacls|taskkill)(?:[\\s;&|]|$)/i;
const SYSTEM_PATH = /(^|[\\/])(?:windows|program files(?: \(x86\))?|programdata|system volume information)(?:[\\/]|$)/i;

export function isRiskyRemoteAction(action: string, params: Record<string, unknown> = {}) {
  if (["services", "disks", "system_files", "admin_processes"].includes(action)) return true;
  const command = typeof params.command === "string" ? params.command : "";
  const target = typeof params.path === "string" ? params.path : "";
  return SYSTEM_COMMANDS.test(command) || SYSTEM_PATH.test(command) || SYSTEM_PATH.test(target);
}

export function validateUserRemoteRequest(action: string, params: Record<string, unknown> = {}) {
  if (isRiskyRemoteAction(action, params)) return { allowed: false, reason: "Benutzerzugriff blockiert Systembereiche oder administrative Aktionen" };
  for (const key of ["path", "cwd"]) {
    const value = params[key];
    if (typeof value === "string" && (/^(?:[A-Za-z]:[\\/]|\\\\|\/etc|\/root|\/var|\/usr|\/opt|\/system|\/library)/i.test(value))) {
      return { allowed: false, reason: "Benutzerzugriff erlaubt nur Benutzerverzeichnisse" };
    }
  }
  return { allowed: true };
}
