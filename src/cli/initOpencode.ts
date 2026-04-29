// Legacy OpenCode scaffold CLI compatibility barrel.
// The runtime-first MCP entrypoint must import this only inside the gated legacy command path.
export type { InitOpenCodeOptions, InitOpenCodeResult } from "../opencode/scaffoldService.js";
export { checkOpenCodeScaffold, initOpenCode } from "../opencode/scaffoldService.js";
