#!/usr/bin/env node
/**
 * Custom Contentstack MCP server (stdio) built on Contentstack's public
 * tool-definition endpoints: https://mcp.contentstack.com/<group>/tools
 *
 * IMPORTANT: stdout is the MCP protocol channel. Log ONLY to stderr.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, realpath, stat } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";

// ---------- Config (all from environment; never hardcode secrets) ----------
const env = process.env;
const REGION = (env.CONTENTSTACK_REGION ?? "NA").toLowerCase();
const GROUPS = (env.CONTENTSTACK_GROUPS ?? "cda,cma").split(",").map((s) => s.trim());
const ALLOW_WRITE = env.CONTENTSTACK_ALLOW_WRITE === "true"; // POST/PUT
const ALLOW_DELETE = env.CONTENTSTACK_ALLOW_DELETE === "true"; // DELETE (separate opt-in)
const TOOL_ALLOWLIST = env.CONTENTSTACK_TOOL_ALLOWLIST
  ? new Set(env.CONTENTSTACK_TOOL_ALLOWLIST.split(",").map((s) => s.trim()))
  : null; // null = all tools in enabled groups
const TIMEOUT_MS = Number(env.CONTENTSTACK_TIMEOUT_MS ?? 30000);
const MAX_RESPONSE_CHARS = Number(env.CONTENTSTACK_MAX_RESPONSE_CHARS ?? 100000);
const UPLOAD_DIR = env.CONTENTSTACK_UPLOAD_DIR; // required for file_path uploads
const UPLOAD_MAX_BYTES = Number(env.CONTENTSTACK_UPLOAD_MAX_BYTES ?? 10 * 1024 * 1024);
const DEFS_BASE ="https://mcp.contentstack.com";
const REGIONS_URL = "https://artifacts.contentstack.com/regions.json";

const SUPPORTED = new Set(["cda", "cma"]); // token-auth groups only (no OAuth)

type Mapper = {
  apiUrl: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  type?: string;
  params?: Record<string, string>;
  queryParams?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  query?: string;
  variables?: Record<string, { type: string; "x-mapFrom": string }>;
};
type ToolDef = {
  name: string;
  description: string;
  group: string;
  mapper: Mapper;
  inputSchema: Record<string, any>;
};

const log = (...a: unknown[]) => console.error("[contentstack-mcp]", ...a);

// ---------- Auth (masked in logs; never returned to the model) ----------
function authHeaders(group: string): Record<string, string> | null {
  const apiKey = env.CONTENTSTACK_API_KEY;
  if (!apiKey) return null;
  if (group === "cda") {
    const t = env.CONTENTSTACK_DELIVERY_TOKEN;
    return t ? { api_key: apiKey, access_token: t } : null;
  }
  if (group === "cma") {
    const t = env.CONTENTSTACK_MANAGEMENT_TOKEN;
    return t ? { api_key: apiKey, authorization: t } : null;
  }
  return null;
}

// ---------- Base URL resolution ----------
const FALLBACK: Record<string, Record<string, string>> = {
  na: { cma: "https://api.contentstack.io", cda: "https://cdn.contentstack.io" },
  eu: { cma: "https://eu-api.contentstack.com", cda: "https://eu-cdn.contentstack.com" },
};
let regionsCache: any | null | undefined;

async function baseUrl(group: string): Promise<string> {
  const override = env[`CONTENTSTACK_${group.toUpperCase()}_BASE_URL`];
  if (override) return override.replace(/\/$/, "");

  const field = group === "cda" ? "contentDelivery" : "contentManagement";
  if (regionsCache === undefined) {
    try {
      const r = await fetch(REGIONS_URL, { signal: AbortSignal.timeout(10000) });
      regionsCache = r.ok ? await r.json() : null;
    } catch {
      regionsCache = null;
    }
  }
  // NOTE: assumes regions.json shape { regions: [{ id, alias[], endpoints{...} }] }.
  // Verify against the live file; falls back to NA/EU table or *_BASE_URL override.
  const list: any[] = regionsCache?.regions ?? [];
  const hit = list.find(
    (r) => String(r.id).toLowerCase() === REGION || (r.alias ?? []).map((a: string) => a.toLowerCase()).includes(REGION)
  );
  let url: string | undefined = hit?.endpoints?.[field];
  if (!url) url = FALLBACK[REGION]?.[group];
  if (!url) throw new Error(`Cannot resolve ${group} base URL for region "${REGION}". Set CONTENTSTACK_${group.toUpperCase()}_BASE_URL.`);
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  return url.replace(/\/$/, "");
}

// ---------- Request building (per Contentstack's doc) ----------
function walk(node: any, args: Record<string, any>): any {
  if (Array.isArray(node)) return node.map((n) => walk(n, args)).filter((x) => x !== undefined);
  if (node && typeof node === "object") {
    if ("x-mapFrom" in node) {
      const v = args[node["x-mapFrom"]];
      if (v === undefined) return undefined;
      return node.type === "array" && !Array.isArray(v) ? [v] : v;
    }
    // If the sub-schema uses JSON-Schema style "properties", walk those.
    const src = node.properties && typeof node.properties === "object" ? node.properties : node;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(src)) {
      const r = walk(v, args);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return node;
}

function buildRequest(def: ToolDef, args: Record<string, any>) {
  const m = def.mapper;
  const consumed = new Set<string>();

  let path = m.apiUrl;
  for (const [placeholder, argName] of Object.entries(m.params ?? {})) {
    const v = args[argName];
    if (v === undefined) throw new Error(`Missing required path parameter: ${argName}`);
    path = path.split(placeholder).join(encodeURIComponent(String(v)));
    consumed.add(argName);
  }

  const qs = new URLSearchParams();
  for (const [key, argName] of Object.entries(m.queryParams ?? {})) {
    const v = args[argName];
    consumed.add(argName);
    if (v === undefined) continue;
    if (key.endsWith("[]") && Array.isArray(v)) v.forEach((x) => qs.append(key, String(x)));
    else qs.append(key, typeof v === "object" ? JSON.stringify(v) : String(v));
  }

  const headers: Record<string, string> = {};
  for (const [h, argName] of Object.entries(m.headers ?? {})) {
    if (args[argName] !== undefined) headers[h] = String(args[argName]);
  }

  let body: unknown;
  if (m.type === "graphql") {
    const variables: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(m.variables ?? {})) variables[name] = args[spec["x-mapFrom"]];
    body = { query: m.query, variables };
  } else if (m.type === "complex" && m.body && typeof m.body === "object") {
    body = walk(m.body, args);
  } else if (typeof m.body === "string") {
    if (args[m.body] !== undefined) body = args[m.body];
    else {
      const leftover = Object.fromEntries(Object.entries(args).filter(([k]) => !consumed.has(k)));
      body = { [m.body]: leftover };
    }
  }
  return { path, query: qs.toString(), headers, body };
}

// ---------- Load tools ----------
const tools = new Map<string, ToolDef>();

function isAllowedByPolicy(def: ToolDef): boolean {
  const method = def.mapper.method;
  if (def.mapper.type === "graphql") return true; // POST used as transport for reads
  if (method === "GET") return true;
  if (method === "DELETE") return ALLOW_DELETE;
  return ALLOW_WRITE; // POST / PUT
}

async function loadTools() {
  for (const group of GROUPS) {
    if (!SUPPORTED.has(group)) {
      log(`Skipping group "${group}": not supported by this server (token auth groups: cda, cma).`);
      continue;
    }
    if (!authHeaders(group)) {
      log(`Skipping group "${group}": missing credentials in environment.`);
      continue;
    }
    const res = await fetch(`${DEFS_BASE}/${group}/tools`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Failed to fetch ${group} tool definitions: HTTP ${res.status}`);
    const defs = (await res.json()) as Record<string, ToolDef>;
    let n = 0;
    for (const def of Object.values(defs)) {
      if (TOOL_ALLOWLIST && !TOOL_ALLOWLIST.has(def.name)) continue;
      if (!isAllowedByPolicy(def)) continue;
      if (tools.has(def.name)) {
        log(`Duplicate tool name "${def.name}" in ${group}; keeping first.`);
        continue;
      }
      tools.set(def.name, { ...def, group });
      n++;
    }
    log(`Group ${group}: registered ${n} tools (write=${ALLOW_WRITE}, delete=${ALLOW_DELETE}).`);
  }
}

// ---------- Custom tool: upload_asset (multipart; not expressible via tool-definition API) ----------
const UPLOAD_TOOL = "upload_asset";
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};
const uploadSchema = {
  type: "object",
  properties: {
    file_path: { type: "string", description: "Local image path; must be inside CONTENTSTACK_UPLOAD_DIR. Provide this OR image_url." },
    image_url: { type: "string", description: "Public https URL of an image to download and upload. Provide this OR file_path." },
    title: { type: "string", description: "Asset title (defaults to the file name)." },
    description: { type: "string" },
    parent_uid: { type: "string", description: "UID of the destination asset folder." },
    tags: { type: "array", items: { type: "string" } },
    branch: { type: "string" },
  },
};

function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const l = ip.toLowerCase();
    if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7));
    return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function assertPublicHttps(u: URL) {
  if (u.protocol !== "https:") throw new Error("image_url must use https.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error("image_url resolves to a private/internal address; blocked.");
}

async function fetchImage(rawUrl: string): Promise<{ data: Buffer; type: string; name: string }> {
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= 3; hop++) {
    await assertPublicHttps(url);
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!Object.values(IMAGE_TYPES).includes(type)) throw new Error(`Not an allowed image type: "${type || "unknown"}".`);
    if (Number(res.headers.get("content-length") ?? 0) > UPLOAD_MAX_BYTES) throw new Error("Image exceeds size limit.");
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > UPLOAD_MAX_BYTES) throw new Error("Image exceeds size limit.");
    const name = decodeURIComponent(path.basename(url.pathname)) || "image";
    return { data, type, name };
  }
  throw new Error("Too many redirects.");
}

async function readLocalImage(p: string): Promise<{ data: Buffer; type: string; name: string }> {
  if (!UPLOAD_DIR) throw new Error("file_path uploads are disabled: set CONTENTSTACK_UPLOAD_DIR.");
  const root = await realpath(UPLOAD_DIR);
  const real = await realpath(path.resolve(root, p));
  const rel = path.relative(root, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("file_path is outside CONTENTSTACK_UPLOAD_DIR.");
  const type = IMAGE_TYPES[path.extname(real).toLowerCase()];
  if (!type) throw new Error(`Unsupported extension. Allowed: ${Object.keys(IMAGE_TYPES).join(", ")}`);
  if ((await stat(real)).size > UPLOAD_MAX_BYTES) throw new Error("Image exceeds size limit.");
  return { data: await readFile(real), type, name: path.basename(real) };
}

async function uploadAsset(args: Record<string, any>) {
  if (!!args.file_path === !!args.image_url) throw new Error("Provide exactly one of file_path or image_url.");
  const img = args.image_url ? await fetchImage(String(args.image_url)) : await readLocalImage(String(args.file_path));
  const form = new FormData();
  form.append("asset[upload]", new Blob([new Uint8Array(img.data)], { type: img.type }), img.name);
  if (args.title) form.append("asset[title]", String(args.title));
  if (args.description) form.append("asset[description]", String(args.description));
  if (args.parent_uid) form.append("asset[parent_uid]", String(args.parent_uid));
  if (Array.isArray(args.tags) && args.tags.length) form.append("asset[tags]", args.tags.join(","));
  const headers: Record<string, string> = { ...authHeaders("cma")! };
  if (args.branch) headers.branch = String(args.branch);
  const url = `${await baseUrl("cma")}/v3/assets`;
  // Content-Type (with boundary) is set by fetch for FormData bodies.
  const res = await fetch(url, { method: "POST", headers, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
  log(`tool=${UPLOAD_TOOL} POST ${url} file=${img.name} bytes=${img.data.length} -> ${res.status}`);
  return { isError: !res.ok, content: [{ type: "text" as const, text: `HTTP ${res.status}\n${await res.text()}` }] };
}

// ---------- MCP server ----------
const server = new Server(
  { name: "contentstack-custom-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const uploadEnabled = () =>
  ALLOW_WRITE && !!authHeaders("cma") && GROUPS.includes("cma") && (!TOOL_ALLOWLIST || TOOL_ALLOWLIST.has(UPLOAD_TOOL));

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...[...tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as any,
    })),
    ...(uploadEnabled()
      ? [{
          name: UPLOAD_TOOL,
          description: "Upload an image as a new Contentstack asset, from a local file (inside the configured upload dir) or a public https image URL.",
          inputSchema: uploadSchema as any,
        }]
      : []),
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const def = tools.get(req.params.name);
  const fail = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
  if (req.params.name === UPLOAD_TOOL && uploadEnabled()) {
    try {
      return await uploadAsset((req.params.arguments ?? {}) as Record<string, any>);
    } catch (e: any) {
      log(`tool=${UPLOAD_TOOL} error: ${e?.message}`);
      return fail(`Upload failed: ${e?.message ?? e}`);
    }
  }
  if (!def) return fail(`Unknown tool: ${req.params.name}`);

  const args = (req.params.arguments ?? {}) as Record<string, any>;
  const missing = (def.inputSchema.required ?? []).filter((k: string) => args[k] === undefined);
  if (missing.length) return fail(`Missing required arguments: ${missing.join(", ")}`);

  try {
    const { path, query, headers, body } = buildRequest(def, args);
    const url = `${await baseUrl(def.group)}${path}${query ? `?${query}` : ""}`;
    const method = def.mapper.method;
    const init: RequestInit = {
      method,
      headers: {
        ...headers,
        ...authHeaders(def.group)!,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    const res = await fetch(url, init);
    let text = await res.text();
    // Audit log: tool, method, URL (no headers/body/tokens), status.
    log(`tool=${def.name} ${method} ${url} -> ${res.status}`);
    if (text.length > MAX_RESPONSE_CHARS) text = text.slice(0, MAX_RESPONSE_CHARS) + "\n…[truncated]";
    return {
      isError: !res.ok,
      content: [{ type: "text" as const, text: `HTTP ${res.status}\n${text}` }],
    };
  } catch (e: any) {
    log(`tool=${def.name} error: ${e?.message}`);
    return fail(`Request failed: ${e?.message ?? e}`);
  }
});

async function main() {
  await loadTools();
  if (tools.size === 0) log("WARNING: no tools registered. Check credentials, groups and policy flags.");
  await server.connect(new StdioServerTransport());
  log(`Running. region=${REGION} tools=${tools.size}`);
}
main().catch((e) => {
  log("Fatal:", e?.message ?? e);
  process.exit(1);
});
