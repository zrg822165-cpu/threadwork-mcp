export const LEGACY_OPENCODE_FLAG = "TEAM_MCP_ENABLE_LEGACY_OPENCODE";

export function assertLegacyOpenCodeInterfaceEnabled(env = process.env): void {
  if (env[LEGACY_OPENCODE_FLAG] === "1") {
    return;
  }

  throw new Error(
    `legacy OpenCode integration is disabled during the runtime redesign. Set ${LEGACY_OPENCODE_FLAG}=1 only for explicit migration work.`
  );
}
