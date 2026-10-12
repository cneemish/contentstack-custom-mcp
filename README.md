# Contentstack custom MCP server (stdio)

Fetches Contentstack's public tool definitions (`https://mcp.contentstack.com/<group>/tools`) and exposes the **cda** and **cma** groups as MCP tools. Requests are built from each tool's `mapper`, as described in Contentstack's "Build Your Own MCP: Tool Definitions API" doc.

## Setup

```bash
npm install
npm run build
```

Requires Node 18.17+.

## Configuration (environment variables)

| Variable | Required | Notes |
|---|---|---|
| `CONTENTSTACK_API_KEY` | yes | Stack API key |
| `CONTENTSTACK_DELIVERY_TOKEN` | for `cda` | Read-only delivery token |
| `CONTENTSTACK_MANAGEMENT_TOKEN` | for `cma` | Scope to the minimum needed |
| `CONTENTSTACK_REGION` | no | Default `NA` (e.g. `EU`) |
| `CONTENTSTACK_GROUPS` | no | Default `cda,cma`. Others (OAuth) are not supported |
| `CONTENTSTACK_ALLOW_WRITE` | no | `true` to expose POST/PUT tools. **Default off** |
| `CONTENTSTACK_ALLOW_DELETE` | no | `true` to expose DELETE tools. **Default off** |
| `CONTENTSTACK_TOOL_ALLOWLIST` | no | Comma-separated tool names; recommended once you know what you need |
| `CONTENTSTACK_CMA_BASE_URL` / `CONTENTSTACK_CDA_BASE_URL` | no | Override region lookup |

Write and delete are opt-in so the server is read-only unless you deliberately enable them. For "read + write", set `CONTENTSTACK_ALLOW_WRITE=true`.

## Claude Desktop

Add to `claude_desktop_config.json` (use the absolute path to `dist/server.js`):

```json
{
  "mcpServers": {
    "contentstack": {
      "command": "node",
      "args": ["/absolute/path/contentstack-mcp/dist/server.js"],
      "env": {
        "CONTENTSTACK_API_KEY": "<set locally>",
        "CONTENTSTACK_DELIVERY_TOKEN": "<set locally>",
        "CONTENTSTACK_MANAGEMENT_TOKEN": "<set locally>",
        "CONTENTSTACK_REGION": "NA",
        "CONTENTSTACK_ALLOW_WRITE": "true"
      }
    }
  }
}
```

## Claude Code

```bash
claude mcp add contentstack \
  --env CONTENTSTACK_API_KEY=... --env CONTENTSTACK_DELIVERY_TOKEN=... \
  --env CONTENTSTACK_MANAGEMENT_TOKEN=... --env CONTENTSTACK_ALLOW_WRITE=true \
  -- node /absolute/path/contentstack-mcp/dist/server.js
```

## Safety checklist

- Start with a **non-production stack** and a scoped management token; do not commit config files containing tokens, and rotate any token that gets exposed.
- Start with `CONTENTSTACK_ALLOW_WRITE` off, test read tools, then enable writes with a `CONTENTSTACK_TOOL_ALLOWLIST`.
- Get approval from IT/security and the client/project owner before connecting to client stacks.
- Audit log goes to stderr: tool, method, URL, status. Headers, tokens and bodies are not logged.
- Test creates/updates on a throwaway content type first; take a stack export/backup before bulk changes.

## Known assumptions to verify

- `regions.json` is assumed to look like `{ regions: [{ id, alias[], endpoints{...} }] }`. If the lookup fails, it falls back to NA/EU defaults or the `*_BASE_URL` overrides.
- "complex" body mapping (`x-mapFrom` schemas) is implemented from the doc's description and is untested against live definitions.
- Not tested against a live Contentstack stack (built without network access).
