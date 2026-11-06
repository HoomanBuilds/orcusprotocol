# Tool profile source notice

The fail-closed profile registration, permitted-definition filtering and
invocation-time refusal mechanisms in `tool-profiles.ts` are adapted to
TypeScript from [Condor](https://github.com/hummingbot/condor/tree/f825393daa8f98c89ffe9e5708f1b7cefcd37dfc),
revision `f825393daa8f98c89ffe9e5708f1b7cefcd37dfc`:

- `mcp_servers/_profiles.py`: `register_tools`, `_gated` and profile resolution.
- `condor/acp/pydantic_ai_client.py`: `_prepare_tools` and `PermissionGatedToolset`.

The adaptation uses the existing in-process structured-tool registry rather than
Condor's Python MCP servers. Interactive chat and unattended strategies have
separate allowlists; checks run both when exposing definitions and before
invocation. Unknown profiles and missing registered tools fail closed.

Copyright (c) 2023 Hummingbot Foundation. Distributed under the MIT license;
the full notice is in [condor-LICENSE.txt](../../../licenses/condor-LICENSE.txt).
