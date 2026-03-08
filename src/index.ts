import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { NamecheapClient, type NamecheapConfig } from "./namecheap-client.js";

dotenv.config();

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function loadConfig(): NamecheapConfig {
  return {
    baseUrl: process.env.NAMECHEAP_BASE_URL?.trim() || "https://www.namecheap.com",
    loginUrl:
      process.env.NAMECHEAP_LOGIN_URL?.trim() ||
      "https://www.namecheap.com/myaccount/login/",
    accountUrl:
      process.env.NAMECHEAP_ACCOUNT_URL?.trim() ||
      "https://ap.www.namecheap.com/",
    userDataDir: process.env.NAMECHEAP_USER_DATA_DIR?.trim() || ".namecheap-profile",
    browserExecutablePath: process.env.NAMECHEAP_BROWSER_EXECUTABLE_PATH?.trim() || undefined,
    headless: readBooleanEnv("NAMECHEAP_HEADLESS", true),
    slowMo: readNumberEnv("NAMECHEAP_SLOW_MO", 0),
    navigationTimeoutMs: readNumberEnv("NAMECHEAP_NAVIGATION_TIMEOUT_MS", 30_000),
  };
}

function jsonResponse(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function decodeJwtExpiry(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

function normalizeImportedCookies(cookies: z.infer<typeof cookieSchema>[]): {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  sameSite: "Strict" | "Lax" | "None";
  secure: boolean;
}[] {
  const nowInSeconds = Math.floor(Date.now() / 1000);
  const authCookie = cookies.find((cookie) => cookie.name === 'x-ncpl-auth');
  const authExpiry = authCookie ? decodeJwtExpiry(authCookie.value) : undefined;
  const fallbackExpiry = authExpiry ?? nowInSeconds + 7 * 24 * 60 * 60;

  const persistenceSensitiveCookies = new Set([
    'x-ncpl-auth',
    'x-ncpl-csrf',
    '__ControllerTempData',
    'SessionId',
    'U',
    '.ncauth',
    '.s',
    'BIGipServerap.www.namecheap.com_http-rev1',
  ]);

  return cookies.map((cookie) => {
    const shouldPersist = persistenceSensitiveCookies.has(cookie.name);
    const expires =
      cookie.expires && cookie.expires > 0
        ? cookie.expires
        : shouldPersist
          ? fallbackExpiry
          : -1;

    return {
      ...cookie,
      expires,
      httpOnly: cookie.httpOnly ?? false,
      path: cookie.path ?? '/',
      sameSite: cookie.sameSite ?? 'Lax',
      secure: cookie.secure ?? true,
    };
  });
}

const config = loadConfig();
const client = new NamecheapClient(config);
const server = new McpServer({
  name: "namecheap-webui-mcp",
  version: "0.1.0",
});

const cookieSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().min(1),
  path: z.string().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
});

server.tool(
  "namecheap_webui_status",
  "Check whether the saved Namecheap auth state is logged in.",
  {
    headed: z.boolean().optional().default(false).describe("Run with a visible browser window."),
  },
  async ({ headed }) => jsonResponse(await client.getStatus({ headed })),
);

server.tool(
  "namecheap_webui_login",
  "Sign into Namecheap with username/password and optionally submit a 2FA code.",
  {
    username: z.string().optional().describe("Namecheap username or email for the initial login step."),
    password: z.string().optional().describe("Namecheap password for the initial login step."),
    twoFactorCode: z.string().optional().describe("Current 2FA code for the second login step after credentials are accepted."),
    headed: z.boolean().optional().default(false).describe("Open a visible browser window when local GUI debugging is available."),
    timeoutMs: z.number().int().positive().optional().default(300_000).describe("How long to wait for login completion."),
  },
  async ({ username, password, twoFactorCode, headed, timeoutMs }) =>
    jsonResponse(await client.login({ username, password, twoFactorCode, headed, timeoutMs })),
);

server.tool(
  "namecheap_webui_import_cookies",
  "Import cookies from an existing logged-in browser session into the saved Namecheap auth state.",
  {
    cookies: z.array(cookieSchema).optional().describe("Playwright-compatible cookies to import directly."),
    cookiesFilePath: z.string().optional().describe("Absolute path to a JSON cookie export file."),
    headed: z.boolean().optional().default(false).describe("Run with a visible browser window."),
  },
  async ({ cookies, cookiesFilePath, headed }) => {
    let resolvedCookies = cookies ?? [];

    if (cookiesFilePath) {
      const raw = await readFile(cookiesFilePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const maybeWrapped =
        parsed && typeof parsed === "object" && "cookies" in parsed
          ? (parsed as { cookies: unknown }).cookies
          : parsed;
      resolvedCookies = z.array(cookieSchema).parse(maybeWrapped);
    }

    if (resolvedCookies.length === 0) {
      throw new Error("Provide either cookies or cookiesFilePath with at least one cookie.");
    }

      return jsonResponse(
        await client.importCookies({
          cookies: normalizeImportedCookies(resolvedCookies),
          headed,
        }),
      );
  },
);

server.tool(
  "namecheap_webui_query",
  "Open a Namecheap dashboard view and return a text snapshot.",
  {
    view: z
      .enum([
        "account",
        "domains",
        "expiring",
        "hosting",
        "private-email",
        "ssl-certificates",
        "apps",
        "my-offers",
        "profile",
        "growth-tools",
        "advanced-dns",
        "domain-manage",
      ])
      .describe("Which Namecheap view to open."),
    domainName: z.string().optional().describe("Required when view is advanced-dns or domain-manage."),
    headed: z.boolean().optional().default(false).describe("Run with a visible browser window."),
  },
  async ({ view, domainName, headed }) => jsonResponse(await client.queryView({ view, domainName, headed })),
);

server.tool(
  "namecheap_dashboard_list_options",
  "List clickable dashboard options currently visible in Namecheap.",
  {
    headed: z.boolean().optional().default(false).describe("Run with a visible browser window."),
  },
  async ({ headed }) => jsonResponse(await client.listDashboardOptions({ headed })),
);

server.tool(
  "namecheap_domains_list",
  "List domains visible in the Namecheap Domain List page.",
  {
    headed: z.boolean().optional().default(false).describe("Run with a visible browser window."),
  },
  async ({ headed }) => jsonResponse(await client.listDomains({ headed })),
);

server.tool(
  "namecheap_domain_get_overview",
  "Get overview details from a domain's Domain Manage page.",
  {
    domainName: z.string().min(3).describe("Full domain name, for example example.com"),
    headed: z.boolean().optional().default(false).describe("Run with a visible browser window."),
  },
  async ({ domainName, headed }) => jsonResponse(await client.getDomainOverview(domainName, { headed })),
);

server.tool(
  "namecheap_domain_get_nameservers",
  "Read nameserver mode and custom nameserver values from Domain Manage.",
  {
    domainName: z.string().min(3).describe("Full domain name, for example example.com"),
    headed: z.boolean().optional().default(false).describe("Run with a visible browser window."),
  },
  async ({ domainName, headed }) => jsonResponse(await client.getNameserverSettings(domainName, { headed })),
);

server.tool(
  "namecheap_domain_set_nameservers",
  "Set nameserver mode to Basic/Free/Premium/Custom and optionally update custom nameserver values.",
  {
    domainName: z.string().min(3).describe("Full domain name, for example example.com"),
    mode: z.enum(["basic", "free", "premium", "custom"]).describe("Nameserver mode to apply."),
    nameservers: z
      .array(z.string().min(3))
      .optional()
      .describe("Required for custom mode. Provide at least two nameserver hostnames."),
    headed: z.boolean().optional().default(false).describe("Run with a visible browser window."),
  },
  async ({ domainName, mode, nameservers, headed }) =>
    jsonResponse(await client.setNameservers({ domainName, mode, nameservers, headed })),
);

server.tool(
  "namecheap_domain_get_features",
  "Read feature toggles on Domain Manage (auto-renew, domain-lock, whois-privacy).",
  {
    domainName: z.string().min(3).describe("Full domain name, for example example.com"),
    headed: z.boolean().optional().default(false).describe("Run with a visible browser window."),
  },
  async ({ domainName, headed }) => jsonResponse(await client.getDomainFeatureStates(domainName, { headed })),
);

server.tool(
  "namecheap_domain_set_feature",
  "Set a Domain Manage feature toggle (auto-renew, domain-lock, whois-privacy).",
  {
    domainName: z.string().min(3).describe("Full domain name, for example example.com"),
    feature: z.enum(["auto-renew", "domain-lock", "whois-privacy"]).describe("Feature toggle to change."),
    enabled: z.boolean().describe("Target state for the feature toggle."),
    headed: z.boolean().optional().default(false).describe("Run with a visible browser window."),
  },
  async ({ domainName, feature, enabled, headed }) =>
    jsonResponse(await client.setDomainFeature({ domainName, feature, enabled, headed })),
);

server.tool(
  "namecheap_dns_get_records",
  "Open a domain's Advanced DNS page and return the visible host records.",
  {
    domainName: z.string().min(3).describe("Full domain name, for example example.com"),
    headed: z.boolean().optional().default(false).describe("Run with a visible browser window."),
  },
  async ({ domainName, headed }) => jsonResponse(await client.getDnsRecords(domainName, { headed })),
);

server.tool(
  "namecheap_dns_set_records",
  "Append or replace host records in the Advanced DNS page for a domain.",
  {
    domainName: z.string().min(3).describe("Full domain name, for example example.com"),
    mode: z.enum(["append", "replace"]).optional().default("append").describe("Append new records or replace the existing host records."),
    headed: z.boolean().optional().default(false).describe("Run with a visible browser window."),
    records: z
      .array(
        z.object({
          type: z.string().min(1).describe("Record type, for example A, CNAME, TXT, MX, AAAA."),
          host: z.string().min(1).describe("Host name, for example @, www, mail."),
          value: z.string().min(1).describe("Record target, address, or content value."),
          ttl: z.string().optional().describe("TTL label or value, for example Automatic or 1800."),
          mxPriority: z.string().optional().describe("MX priority when required."),
        }),
      )
      .min(1)
      .describe("The DNS records to create in the web UI."),
  },
  async ({ domainName, records, mode, headed }) =>
    jsonResponse(await client.setDnsRecords({ domainName, records, mode, headed })),
);

export async function startServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]);
}

process.on("SIGINT", async () => {
  await client.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await client.close();
  process.exit(0);
});

if (isMainModule()) {
  startServer().catch(async (error: unknown) => {
    console.error(error);
    await client.close();
    process.exit(1);
  });
}
