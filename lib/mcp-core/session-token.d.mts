export type TrustedMcpTokenClaims = {
  v: 1;
  exp: number;
  userId: string;
  uid: number;
  gid: number;
  workspaceRoot: string;
  home: string;
  trustedInternal: true;
  [key: string]: unknown;
};
export function signTrustedMcpSession(claims: TrustedMcpTokenClaims, secret: string): string;
export function verifyTrustedMcpSession(token: string, secret: string, now?: number): TrustedMcpTokenClaims | null;
