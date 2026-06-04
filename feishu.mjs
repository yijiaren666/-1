import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MODULE_PATH = fileURLToPath(import.meta.url);
const ROOT = path.dirname(MODULE_PATH);
const ENV_PATH = path.join(ROOT, ".env");
const API_BASE = "https://open.feishu.cn";

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv(ENV_PATH);

function requireConfig() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("Missing FEISHU_APP_ID or FEISHU_APP_SECRET. Set them as environment variables.");
  }
  return { appId, appSecret };
}

export async function request(method, apiPath, { token, body, query } = {}) {
  const url = new URL(apiPath.startsWith("http") ? apiPath : `${API_BASE}${apiPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    }
  }
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok || (typeof data.code === "number" && data.code !== 0)) {
    const msg = data.msg || data.error || res.statusText;
    throw new Error(`${method} ${url.pathname} failed: ${res.status} ${msg}\n${JSON.stringify(data, null, 2)}`);
  }
  return data;
}

export async function getTenantAccessToken() {
  const { appId, appSecret } = requireConfig();
  const data = await request("POST", "/open-apis/auth/v3/tenant_access_token/internal", {
    body: { app_id: appId, app_secret: appSecret },
  });
  const token = data.tenant_access_token || data.data?.tenant_access_token;
  if (!token) throw new Error(`Token response did not include tenant_access_token: ${JSON.stringify(data, null, 2)}`);
  return token;
}

function extractBase(input) {
  const url = new URL(input);
  const parts = url.pathname.split("/").filter(Boolean);
  const baseIndex = parts.indexOf("base");
  const appToken = baseIndex === -1 ? parts.at(-1) : parts[baseIndex + 1];
  const tableId = url.searchParams.get("table");
  if (!appToken || !tableId) throw new Error("Base URL must include app token and table id.");
  return { appToken, tableId, viewId: url.searchParams.get("view") };
}

export async function readBase(input, options = {}) {
  const tenantToken = await getTenantAccessToken();
  const { appToken, tableId, viewId } = extractBase(input);
  const base = `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}`;
  const fields = await request("GET", `${base}/fields`, { token: tenantToken });
  const records = await request("GET", `${base}/records`, {
    token: tenantToken,
    query: {
      page_size: options.limit || "100",
      view_id: options.view || viewId,
    },
  });
  return { fields, records };
}