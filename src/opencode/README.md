# Legacy OpenCode Scaffold Boundary

This directory contains two different kinds of OpenCode-related code:

- Runtime backend support that remains part of the current product, such as model discovery and the runtime OpenCode backend.
- Legacy scaffold compatibility code that writes `.opencode` files or serves the old `init-opencode`, `opencode-tool`, and `dogfood-opencode` CLI paths.

Do not add new product behavior to the scaffold-writing path. Keep it tested and usable for migration, but route new default work through runtime modules, `team_work`, and the registered runtime MCP surface.
