import { existsSync } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Cookie, type Page } from "playwright";

const require = createRequire(import.meta.url);
type CamoufoxLoader = {
  Camoufox: (options: Record<string, unknown>) => Promise<Browser>;
};
const { Camoufox } = require("camoufox") as CamoufoxLoader;

export interface NamecheapConfig {
  baseUrl: string;
  loginUrl: string;
  accountUrl: string;
  userDataDir: string;
  browserExecutablePath?: string;
  headless: boolean;
  slowMo: number;
  navigationTimeoutMs: number;
}

export interface NamecheapDomainSummary {
  domain: string;
  summary: string;
}

export interface NamecheapDnsRecord {
  type: string;
  host: string;
  value: string;
  ttl?: string;
  mxPriority?: string;
}

export interface NamecheapDnsWriteInput {
  domainName: string;
  records: NamecheapDnsRecord[];
  mode: "append" | "replace";
  headed?: boolean;
}

export type NamecheapDashboardView =
  | "account"
  | "domains"
  | "expiring"
  | "hosting"
  | "private-email"
  | "ssl-certificates"
  | "apps"
  | "my-offers"
  | "profile"
  | "growth-tools"
  | "advanced-dns"
  | "domain-manage";

export interface NamecheapDashboardOption {
  label: string;
  href: string;
  section: string;
}

export interface NamecheapDomainOverview {
  domainName: string;
  currentUrl: string;
  nameserverMode: string;
  usesNamecheapDns: boolean;
  expiresOn?: string;
  autoRenewEnabled: boolean | null;
  domainLockEnabled: boolean | null;
  whoisPrivacyEnabled: boolean | null;
  eppCodeVisible: boolean;
  snippet: string;
}

export interface NamecheapNameserverSettings {
  domainName: string;
  currentUrl: string;
  mode: string;
  customNameservers: string[];
  snippet: string;
}

export type NamecheapDomainFeature = "auto-renew" | "domain-lock" | "whois-privacy";

export interface NamecheapDomainFeatureState {
  feature: NamecheapDomainFeature;
  enabled: boolean | null;
}

export interface NamecheapNameserverWriteInput {
  domainName: string;
  mode: "basic" | "free" | "premium" | "custom";
  nameservers?: string[];
  headed?: boolean;
}

export interface NamecheapSessionStatus {
  authenticated: boolean;
  currentUrl: string;
  loginUrl: string;
  accountUrl: string;
  userDataDir: string;
  message: string;
}

export interface NamecheapLoginResult extends NamecheapSessionStatus {
  stage: "authenticated" | "two-factor-required" | "credentials-required";
  requiresTwoFactor: boolean;
}

type SessionOptions = {
  headed?: boolean;
  persistState?: boolean;
};

const DOMAIN_REGEX = /\b(?:xn--)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z]{2,63}\b/i;
const DEFAULT_LOGIN_WAIT_MS = 5 * 60_000;
const MAX_BROWSER_ATTEMPTS = 4;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEmpty(value: string | null | undefined): boolean {
  return normalizeText(value).length === 0;
}

export class NamecheapClient {
  constructor(private readonly config: NamecheapConfig) {}

  async close(): Promise<void> {}

  private get storageStatePath(): string {
    return path.join(this.config.userDataDir, "storage-state.json");
  }

  private buildAppUrl(pathname: string): string {
    return new URL(pathname, trimTrailingSlash(this.config.accountUrl) + "/").toString();
  }

  async getStatus(options?: { headed?: boolean }): Promise<NamecheapSessionStatus> {
    return this.withPage({ headed: options?.headed, persistState: true }, async ({ page }) => {
      await page.goto(this.config.accountUrl, {
        timeout: this.config.navigationTimeoutMs,
        waitUntil: "domcontentloaded",
      });

      const authenticated = await this.isAuthenticated(page);

      return {
        authenticated,
        currentUrl: page.url(),
        loginUrl: this.config.loginUrl,
        accountUrl: this.config.accountUrl,
        userDataDir: this.config.userDataDir,
        message: authenticated
          ? "Logged in. The stored auth state can be reused in fresh browser sessions."
          : "Not logged in. Run the login tool or import a fuller Namecheap cookie set, then call status again.",
      };
    });
  }

  async login(options?: {
    username?: string;
    password?: string;
    twoFactorCode?: string;
    headed?: boolean;
    timeoutMs?: number;
  }): Promise<NamecheapLoginResult> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_LOGIN_WAIT_MS;

    return this.withPage({ headed: options?.headed, persistState: true }, async ({ page }) => {
      await page.goto(this.config.accountUrl, {
        timeout: this.config.navigationTimeoutMs,
        waitUntil: "domcontentloaded",
      });

      const alreadyAuthenticated = await this.isAuthenticated(page);
      if (alreadyAuthenticated) {
        return {
          stage: "authenticated",
          requiresTwoFactor: false,
          authenticated: true,
          currentUrl: page.url(),
          loginUrl: this.config.loginUrl,
          accountUrl: this.config.accountUrl,
          userDataDir: this.config.userDataDir,
          message: "Already logged in.",
        };
      }

      if (options?.username && options?.password) {
        await this.openLoginPage(page);
        await this.fillLoginCredentials(page, options.username, options.password);
        await this.clickFirst(page, [
          'input[type="submit"][value*="Sign in" i]',
          'button:has-text("Sign in")',
          'text="Sign in"',
        ]);
        await this.waitForAuthenticationStep(page, timeoutMs);
      }

      if (options?.twoFactorCode) {
        if (!(await this.isTwoFactorPrompt(page))) {
          await page.goto(this.config.accountUrl, {
            timeout: this.config.navigationTimeoutMs,
            waitUntil: "domcontentloaded",
          });
        }

        if (!(await this.isTwoFactorPrompt(page))) {
          return {
            stage: "credentials-required",
            requiresTwoFactor: false,
            authenticated: false,
            currentUrl: page.url(),
            loginUrl: this.config.loginUrl,
            accountUrl: this.config.accountUrl,
            userDataDir: this.config.userDataDir,
            message:
              "The saved auth state is not currently at the Namecheap 2FA prompt. Submit username/password first, then send the current 2FA code.",
          };
        }

        await this.fillTwoFactorCode(page, options.twoFactorCode);
        await this.clickFirst(page, [
          'input[type="submit"][value*="Verify" i]',
          'input[type="submit"][value*="Continue" i]',
          'button:has-text("Verify")',
          'button:has-text("Continue")',
          'button:has-text("Submit")',
          'text="Verify"',
        ]);
        await this.waitForAuthenticationStep(page, timeoutMs);
      }

      if (await this.isAuthenticated(page)) {
        return {
          stage: "authenticated",
          requiresTwoFactor: false,
          authenticated: true,
          currentUrl: page.url(),
          loginUrl: this.config.loginUrl,
          accountUrl: this.config.accountUrl,
          userDataDir: this.config.userDataDir,
          message: "Login detected and persisted to the saved auth state.",
        };
      }

      if (await this.isTwoFactorPrompt(page)) {
        return {
          stage: "two-factor-required",
          requiresTwoFactor: true,
          authenticated: false,
          currentUrl: page.url(),
          loginUrl: this.config.loginUrl,
          accountUrl: this.config.accountUrl,
          userDataDir: this.config.userDataDir,
          message: "Username/password were accepted. Send the current 2FA code and call the login tool again with `twoFactorCode`.",
        };
      }

      return {
        stage: "credentials-required",
        requiresTwoFactor: false,
        authenticated: false,
        currentUrl: page.url(),
        loginUrl: this.config.loginUrl,
        accountUrl: this.config.accountUrl,
        userDataDir: this.config.userDataDir,
        message:
          options?.username && options?.password
            ? "Namecheap did not complete authentication. Check the credentials or look for a challenge page that needs a selector update."
            : "Provide username/password to start a normal Namecheap login flow.",
      };
    });
  }

  async listDomains(options?: { headed?: boolean }): Promise<NamecheapDomainSummary[]> {
    return this.withAuthenticatedPage(options?.headed, async (page) => {
      await this.openDomainList(page);
      return this.extractDomains(page);
    });
  }

  async importCookies(input: {
    cookies: Cookie[];
    headed?: boolean;
  }): Promise<NamecheapSessionStatus & { importedCookies: number }> {
    return this.withPage({ headed: input.headed, persistState: true }, async ({ page, context }) => {
      await context.addCookies(input.cookies);
      const persistedCookies = await context.cookies([
        this.config.baseUrl,
        this.config.loginUrl,
        this.config.accountUrl,
      ]);
      await page.goto(this.config.accountUrl, {
        timeout: this.config.navigationTimeoutMs,
        waitUntil: "domcontentloaded",
      });

      const authenticated = await this.isAuthenticated(page);

      return {
        importedCookies: persistedCookies.length,
        authenticated,
        currentUrl: page.url(),
        loginUrl: this.config.loginUrl,
        accountUrl: this.config.accountUrl,
        userDataDir: this.config.userDataDir,
        message: authenticated
          ? "Cookies imported and the Namecheap session looks authenticated."
          : "Cookies imported, but the session is still not authenticated. Export a fuller set of Namecheap cookies from an already logged-in browser.",
      };
    });
  }

  async queryView(input: {
    view: NamecheapDashboardView;
    domainName?: string;
    headed?: boolean;
  }): Promise<{
    view: NamecheapDashboardView;
    currentUrl: string;
    snippet: string;
  }> {
    return this.withAuthenticatedPage(input.headed, async (page) => {
      if (input.view === "account") {
        await page.goto(this.config.accountUrl, {
          timeout: this.config.navigationTimeoutMs,
          waitUntil: "domcontentloaded",
        });
      } else if (input.view === "domains") {
        await this.openDomainList(page);
      } else if (input.view === "advanced-dns") {
        if (!input.domainName) {
          throw new Error("domainName is required when querying the advanced-dns view.");
        }

        await this.openAdvancedDns(page, input.domainName);
      } else if (input.view === "domain-manage") {
        if (!input.domainName) {
          throw new Error("domainName is required when querying the domain-manage view.");
        }

        await this.openDomainControlPanel(page, input.domainName);
      } else {
        await this.openDashboardMenuView(page, input.view);
      }

      const snippet = await page.locator("body").evaluate((body) =>
        (body.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 2_000),
      );

      return {
        view: input.view,
        currentUrl: page.url(),
        snippet,
      };
    });
  }

  async listDashboardOptions(options?: { headed?: boolean }): Promise<NamecheapDashboardOption[]> {
    return this.withAuthenticatedPage(options?.headed, async (page) => {
      await page.goto(this.config.accountUrl, {
        timeout: this.config.navigationTimeoutMs,
        waitUntil: "domcontentloaded",
      });

      await page.waitForTimeout(800);
      return this.extractDashboardOptions(page);
    });
  }

  async getDomainOverview(
    domainName: string,
    options?: { headed?: boolean },
  ): Promise<NamecheapDomainOverview> {
    return this.withAuthenticatedPage(options?.headed, async (page) => {
      await this.openDomainControlPanel(page, domainName);

      const snippet = await page.locator("body").evaluate((body) =>
        (body.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 4_000),
      );
      const nameserverMode = await this.readNameserverMode(page);

      return {
        domainName: normalizeDomain(domainName),
        currentUrl: page.url(),
        nameserverMode,
        usesNamecheapDns: ["BasicDNS", "PremiumDNS", "FreeDNS"].includes(nameserverMode),
        expiresOn: this.extractExpiryText(snippet),
        autoRenewEnabled: this.extractBooleanFeature(snippet, ["auto renew", "auto-renew", "auto renewal"]),
        domainLockEnabled: this.extractBooleanFeature(snippet, ["domain lock", "registrar lock", "transfer lock"]),
        whoisPrivacyEnabled: this.extractBooleanFeature(snippet, ["whois guard", "whois privacy", "privacy protection"]),
        eppCodeVisible: /authorization code|epp code|auth code/i.test(snippet),
        snippet,
      };
    });
  }

  async getNameserverSettings(
    domainName: string,
    options?: { headed?: boolean },
  ): Promise<NamecheapNameserverSettings> {
    return this.withAuthenticatedPage(options?.headed, async (page) => {
      await this.openDomainControlPanel(page, domainName);

      const settings = await this.extractNameserverSettings(page);
      return {
        domainName: normalizeDomain(domainName),
        currentUrl: page.url(),
        ...settings,
      };
    });
  }

  async setNameservers(input: NamecheapNameserverWriteInput): Promise<{
    domainName: string;
    currentUrl: string;
    saved: boolean;
    modeBefore: string;
    modeAfter: string;
    customNameserversAfter: string[];
  }> {
    return this.withAuthenticatedPage(input.headed, async (page) => {
      const normalizedDomainName = normalizeDomain(input.domainName);
      await this.openDomainControlPanel(page, normalizedDomainName);

      const before = await this.extractNameserverSettings(page);
      const nameservers = (input.nameservers ?? [])
        .map((value) => normalizeText(value).toLowerCase())
        .filter((value) => DOMAIN_REGEX.test(value));

      if (input.mode === "custom" && nameservers.length < 2) {
        throw new Error("Custom nameservers require at least two valid nameservers.");
      }

      const result = await this.applyNameserverSettings(page, {
        mode: input.mode,
        nameservers,
      });

      if (!result.applied) {
        throw new Error(result.message);
      }

      await this.saveDomainChanges(page);
      const after = await this.extractNameserverSettings(page);

      return {
        domainName: normalizedDomainName,
        currentUrl: page.url(),
        saved: true,
        modeBefore: before.mode,
        modeAfter: after.mode,
        customNameserversAfter: after.customNameservers,
      };
    });
  }

  async getDomainFeatureStates(
    domainName: string,
    options?: { headed?: boolean },
  ): Promise<{
    domainName: string;
    currentUrl: string;
    states: NamecheapDomainFeatureState[];
  }> {
    return this.withAuthenticatedPage(options?.headed, async (page) => {
      await this.openDomainControlPanel(page, domainName);
      const snippet = await page.locator("body").evaluate((body) => (body.textContent ?? "").replace(/\s+/g, " "));

      return {
        domainName: normalizeDomain(domainName),
        currentUrl: page.url(),
        states: [
          {
            feature: "auto-renew",
            enabled: this.extractBooleanFeature(snippet, ["auto renew", "auto-renew", "auto renewal"]),
          },
          {
            feature: "domain-lock",
            enabled: this.extractBooleanFeature(snippet, ["domain lock", "registrar lock", "transfer lock"]),
          },
          {
            feature: "whois-privacy",
            enabled: this.extractBooleanFeature(snippet, ["whois guard", "whois privacy", "privacy protection"]),
          },
        ],
      };
    });
  }

  async setDomainFeature(input: {
    domainName: string;
    feature: NamecheapDomainFeature;
    enabled: boolean;
    headed?: boolean;
  }): Promise<{
    domainName: string;
    currentUrl: string;
    feature: NamecheapDomainFeature;
    before: boolean | null;
    after: boolean | null;
    changed: boolean;
  }> {
    return this.withAuthenticatedPage(input.headed, async (page) => {
      const normalizedDomainName = normalizeDomain(input.domainName);
      await this.openDomainControlPanel(page, normalizedDomainName);

      const before = await this.extractFeatureStateFromDom(page, input.feature);
      const toggled = await this.toggleDomainFeature(page, {
        feature: input.feature,
        enabled: input.enabled,
      });

      if (!toggled.found) {
        throw new Error(`Could not find a visible control for ${input.feature} on the Domain Manage page.`);
      }

      if (toggled.changed) {
        await this.saveDomainChanges(page);
      }

      const after = await this.extractFeatureStateFromDom(page, input.feature);

      return {
        domainName: normalizedDomainName,
        currentUrl: page.url(),
        feature: input.feature,
        before,
        after,
        changed: toggled.changed,
      };
    });
  }

  async getDnsRecords(
    domainName: string,
    options?: { headed?: boolean },
  ): Promise<{
    domainName: string;
    currentUrl: string;
    nameserverMode: string;
    records: NamecheapDnsRecord[];
  }> {
    return this.withAuthenticatedPage(options?.headed, async (page) => {
      await this.openAdvancedDns(page, domainName);

      return {
        domainName: normalizeDomain(domainName),
        currentUrl: page.url(),
        nameserverMode: await this.readNameserverMode(page),
        records: await this.extractDnsRecords(page),
      };
    });
  }

  async setDnsRecords(input: NamecheapDnsWriteInput): Promise<{
    domainName: string;
    currentUrl: string;
    mode: "append" | "replace";
    saved: boolean;
    recordsRequested: number;
    recordsDetectedAfterSave: NamecheapDnsRecord[];
  }> {
    return this.withAuthenticatedPage(input.headed, async (page) => {
      await this.openAdvancedDns(page, input.domainName);

      if (!(await this.isUsingNamecheapDns(page))) {
        throw new Error(
          "Host Records are not editable for this domain in Namecheap. Switch the domain to BasicDNS/FreeDNS/PremiumDNS first.",
        );
      }

      if (input.mode === "replace") {
        await this.removeExistingHostRecords(page);
      }

      for (const record of input.records) {
        await this.addHostRecord(page, record);
      }

      await this.saveDnsChanges(page);

      return {
        domainName: normalizeDomain(input.domainName),
        currentUrl: page.url(),
        mode: input.mode,
        saved: true,
        recordsRequested: input.records.length,
        recordsDetectedAfterSave: await this.extractDnsRecords(page),
      };
    });
  }

  private async withAuthenticatedPage<T>(headed: boolean | undefined, task: (page: Page) => Promise<T>): Promise<T> {
    return this.withPage({ headed, persistState: true }, async ({ page }) => {
      await page.goto(this.config.accountUrl, {
        timeout: this.config.navigationTimeoutMs,
        waitUntil: "domcontentloaded",
      });

      if (!(await this.isAuthenticated(page))) {
        throw new Error(
          "Namecheap is not logged in. Run the login tool with username/password, then submit the 2FA code if Namecheap asks for it.",
        );
      }

      return task(page);
    });
  }

  private async withPage<T>(options: SessionOptions, task: (input: { browser: Browser; context: BrowserContext; page: Page }) => Promise<T>): Promise<T> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < MAX_BROWSER_ATTEMPTS; attempt += 1) {
      let browser: Browser | null = null;
      let context: BrowserContext | null = null;

      try {
        browser = await this.launchBrowser({
          headed: options.headed,
          headless: !(options.headed ?? false) && this.config.headless,
        });

        context = await browser.newContext({
          acceptDownloads: false,
          storageState: await this.readStorageState(),
          viewport: { width: 1440, height: 1100 },
        });

        await context.addInitScript(() => {
          Object.defineProperty(navigator, "webdriver", {
            configurable: true,
            get: () => false,
          });
        });

        const page = await context.newPage();
        page.setDefaultTimeout(this.config.navigationTimeoutMs);
        page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);

        const result = await task({ browser, context, page });
        return result;
      } catch (error) {
        lastError = error;
        const recoverable = this.isRecoverableBrowserError(error);
        if (!recoverable || attempt === MAX_BROWSER_ATTEMPTS - 1) {
          throw error;
        }

        await sleep(1000 * (attempt + 1));
      } finally {
        if (context && options.persistState) {
          await this.saveStorageState(context).catch(() => undefined);
        }

        if (context) {
          await context.close().catch(() => undefined);
        }

        if (browser) {
          await browser.close().catch(() => undefined);
        }
      }
    }

    throw (lastError instanceof Error ? lastError : new Error("namecheap_browser_session_failed"));
  }

  private buildLaunchArgs(): string[] {
    return [
      "--disable-blink-features=AutomationControlled",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-dev-shm-usage",
    ];
  }

  private async launchBrowser(input: { headed?: boolean; headless: boolean }): Promise<Browser> {
    const launchBase = {
      env: { ...process.env },
      headless: input.headless,
      slowMo: this.config.slowMo,
      args: this.buildLaunchArgs(),
    };

    const configuredExecutable = normalizeText(this.config.browserExecutablePath);
    const executableCandidates = [configuredExecutable, "/usr/bin/chromium-browser", "/usr/bin/chromium"]
      .filter((value) => !isEmpty(value) && existsSync(value));

    const attempts: Array<() => Promise<Browser>> = [
      () =>
        Camoufox({
          ...(configuredExecutable ? { executable_path: configuredExecutable } : {}),
          env: { ...process.env },
          geoip: false,
          headless: input.headless,
          humanize: false,
          block_webgl: true,
          iKnowWhatImDoing: true,
        }),
      () => chromium.launch({
        ...launchBase,
        channel: "chromium",
      }),
      ...executableCandidates.map((executablePath) => () =>
        chromium.launch({
          ...launchBase,
          executablePath,
        })),
    ];

    let lastError: unknown = null;
    for (const attempt of attempts) {
      try {
        return await attempt();
      } catch (error) {
        lastError = error;
      }
    }

    throw (lastError instanceof Error ? lastError : new Error("namecheap_browser_launch_failed"));
  }

  private isRecoverableBrowserError(error: unknown): boolean {
    return /Page crashed|browser.*closed|Target page, context or browser has been closed|Failed to launch the browser process|browserType\.launch/i.test(
      toErrorMessage(error),
    );
  }

  private async saveStorageState(context: BrowserContext): Promise<void> {
    await mkdir(this.config.userDataDir, { recursive: true });
    await context.storageState({ path: this.storageStatePath });
  }

  private async readStorageState(): Promise<string | undefined> {
    try {
      await access(this.storageStatePath);
      const raw = await readFile(this.storageStatePath, "utf8");
      const parsed = JSON.parse(raw) as { cookies?: unknown[]; origins?: unknown[] };
      if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
        throw new Error("invalid_storage_state");
      }
      return this.storageStatePath;
    } catch {
      await this.migrateLegacyProfileToStorageState().catch(() => undefined);
    }

    try {
      await access(this.storageStatePath);
      return this.storageStatePath;
    } catch {
      return undefined;
    }
  }

  private async migrateLegacyProfileToStorageState(): Promise<void> {
    const defaultProfilePath = path.join(this.config.userDataDir, "Default");

    try {
      await access(defaultProfilePath);
    } catch {
      return;
    }

    let context: BrowserContext | null = null;

    try {
      const persistentBase = {
        env: { ...process.env },
        headless: this.config.headless,
        slowMo: this.config.slowMo,
        acceptDownloads: false,
        viewport: { width: 1440, height: 1100 },
        args: this.buildLaunchArgs(),
      };

      const configuredExecutable = normalizeText(this.config.browserExecutablePath);
      const executableCandidates = [configuredExecutable, "/usr/bin/chromium-browser", "/usr/bin/chromium"]
        .filter((value) => !isEmpty(value));

      const attempts: Array<() => Promise<BrowserContext>> = [
        () =>
          chromium.launchPersistentContext(this.config.userDataDir, {
            ...persistentBase,
            channel: "chromium",
          }),
        ...executableCandidates.map((executablePath) => () =>
          chromium.launchPersistentContext(this.config.userDataDir, {
            ...persistentBase,
            executablePath,
          })),
      ];

      let lastError: unknown = null;
      for (const attempt of attempts) {
        try {
          context = await attempt();
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (!context) {
        throw (lastError instanceof Error ? lastError : new Error("namecheap_profile_migration_launch_failed"));
      }

      await context.storageState({ path: this.storageStatePath });
    } finally {
      if (context) {
        await context.close().catch(() => undefined);
      }
    }
  }

  private async openLoginPage(page: Page): Promise<void> {
    await page.goto(this.config.loginUrl, {
      timeout: this.config.navigationTimeoutMs,
      waitUntil: "domcontentloaded",
    });
  }

  private async isAuthenticated(page: Page): Promise<boolean> {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);

    const url = page.url().toLowerCase();
    if (url.includes("/myaccount/login") || url.includes("/apps/sso/login")) {
      return false;
    }

    const title = normalizeText(await page.title().catch(() => ""));
    if (/just a moment|attention required|login/i.test(title)) {
      return false;
    }

    const bodyText = normalizeText(await page.locator("body").textContent().catch(() => "")).toLowerCase();

    if (
      bodyText.includes("log in to your account") ||
      bodyText.includes("checking your browser") ||
      bodyText.includes("enable javascript and cookies to continue")
    ) {
      return false;
    }

    const loginInputs = await page
      .locator('input[placeholder*="Username" i], input[placeholder*="Password" i]')
      .count();

    if (loginInputs >= 2) {
      return false;
    }

    const hasDomainListLink = await page
      .locator('a[href*="/Domains" i], a[href*="/domains/domaincontrolpanel/" i]')
      .first()
      .isVisible()
      .catch(() => false);
    const hasDashboardMarkers = await page
      .getByText(/Expiring \/ Expired|Recently Active in Your Account|Domain List|Advanced DNS/i)
      .first()
      .isVisible()
      .catch(() => false);

    return hasDomainListLink || hasDashboardMarkers;
  }

  private async isTwoFactorPrompt(page: Page): Promise<boolean> {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);

    const url = page.url().toLowerCase();
    if (url.includes("/twofa/")) {
      return true;
    }

    const bodyText = normalizeText(await page.locator("body").textContent().catch(() => "")).toLowerCase();

    return [
      "two-factor",
      "2fa",
      "verification code",
      "authenticator code",
      "device verification",
      "enter the code",
      "one-time code",
    ].some((marker) => bodyText.includes(marker));
  }

  private async waitForAuthenticationStep(page: Page, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await this.isAuthenticated(page)) {
        return;
      }

      if (await this.isTwoFactorPrompt(page)) {
        return;
      }

      const url = page.url().toLowerCase();
      if (url.includes("/myaccount/login") || url.includes("/apps/sso/login")) {
        const bodyText = normalizeText(await page.locator("body").textContent().catch(() => "")).toLowerCase();
        if (bodyText.includes("incorrect") || bodyText.includes("invalid") || bodyText.includes("required")) {
          return;
        }
      }

      await page.waitForTimeout(500);
    }
  }

  private async fillLoginCredentials(page: Page, username: string, password: string): Promise<void> {
    const usernameInput = page.locator('input[name="LoginUserName"]:visible').last();
    const passwordInput = page.locator('input[name="LoginPassword"]:visible').last();

    if (!(await usernameInput.isVisible().catch(() => false))) {
      throw new Error("Could not find the visible Namecheap username input.");
    }

    if (!(await passwordInput.isVisible().catch(() => false))) {
      throw new Error("Could not find the visible Namecheap password input.");
    }

    await usernameInput.click();
    await usernameInput.press("Control+A").catch(() => undefined);
    await usernameInput.pressSequentially(username, { delay: 35 });

    await passwordInput.click();
    await passwordInput.press("Control+A").catch(() => undefined);
    await passwordInput.pressSequentially(password, { delay: 35 });

    await page.evaluate((rawPassword) => {
      const passwordValue = rawPassword;
      const hiddenInputs = Array.from(
        document.querySelectorAll('input[type="hidden"][name*="LoginPassword" i]'),
      ).filter((input): input is HTMLInputElement => input instanceof HTMLInputElement);

      for (const input of hiddenInputs) {
        input.value = passwordValue;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }

      const submitInputs = Array.from(document.querySelectorAll('input[type="submit"], button')).filter(
        (input): input is HTMLInputElement | HTMLButtonElement =>
          input instanceof HTMLInputElement || input instanceof HTMLButtonElement,
      );

      for (const input of submitInputs) {
        const label = [input.getAttribute("value"), input.textContent].join(" ").toLowerCase();
        if (label.includes("sign in")) {
          input.disabled = false;
          input.removeAttribute("disabled");
        }
      }
    }, password);
  }

  private async fillTwoFactorCode(page: Page, twoFactorCode: string): Promise<void> {
    const applied = await page.evaluate((rawCode) => {
      const code = rawCode.trim();
      const isVisible = (element: Element): boolean => {
        const htmlElement = element as HTMLElement;
        const style = window.getComputedStyle(htmlElement);
        const rect = htmlElement.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };

      const inputs = Array.from(document.querySelectorAll("input")).filter((input): input is HTMLInputElement => {
        if (!(input instanceof HTMLInputElement) || !isVisible(input)) {
          return false;
        }

        const type = (input.type || "text").toLowerCase();
        if (!["text", "tel", "number", "password"].includes(type)) {
          return false;
        }

        const hint = [
          input.name,
          input.id,
          input.placeholder,
          input.getAttribute("aria-label") ?? "",
          input.closest("label")?.textContent ?? "",
          input.parentElement?.textContent ?? "",
        ]
          .join(" ")
          .toLowerCase();

        return /(code|2fa|two-factor|verification|authenticator|otp|token)/i.test(hint) || input.maxLength === 1;
      });

      const fire = (input: HTMLInputElement, value: string): void => {
        input.focus();
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.blur();
      };

      const single = inputs.find((input) => input.maxLength <= 0 || input.maxLength >= code.length);
      if (single) {
        fire(single, code);
        return true;
      }

      const digitInputs = inputs.filter((input) => input.maxLength === 1);
      if (digitInputs.length >= code.length) {
        code.split("").forEach((digit, index) => {
          const input = digitInputs[index];
          if (input) {
            fire(input, digit);
          }
        });
        return true;
      }

      return false;
    }, twoFactorCode);

    if (!applied) {
      throw new Error("Could not find the Namecheap 2FA code input fields.");
    }
  }

  private async openDomainList(page: Page): Promise<void> {
    await page.goto(this.buildAppUrl("/Domains/DomainList"), {
      timeout: this.config.navigationTimeoutMs,
      waitUntil: "domcontentloaded",
    });

    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(750);
  }

  private async openDomainControlPanel(page: Page, domainName: string): Promise<void> {
    const normalized = normalizeDomain(domainName);
    await page.goto(this.buildAppUrl(`/Domains/DomainControlPanel/${encodeURIComponent(normalized)}`), {
      timeout: this.config.navigationTimeoutMs,
      waitUntil: "domcontentloaded",
    });

    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(1_000);

    const hasDomainHeading = await page
      .getByText(new RegExp(escapeRegex(normalized), "i"))
      .first()
      .isVisible()
      .catch(() => false);

    if (!hasDomainHeading) {
      throw new Error(`Could not open the Domain Manage page for ${normalized}.`);
    }
  }

  private async openDashboardMenuView(page: Page, view: Exclude<NamecheapDashboardView, "account" | "domains" | "advanced-dns" | "domain-manage">): Promise<void> {
    await page.goto(this.config.accountUrl, {
      timeout: this.config.navigationTimeoutMs,
      waitUntil: "domcontentloaded",
    });

    const labelsByView: Record<Exclude<NamecheapDashboardView, "account" | "domains" | "advanced-dns" | "domain-manage">, string[]> = {
      expiring: ["Expiring", "Expired"],
      hosting: ["Hosting List", "Hosting"],
      "private-email": ["Private Email"],
      "ssl-certificates": ["SSL Certificates", "SSL"],
      apps: ["Apps"],
      "my-offers": ["My Offers", "Offers"],
      profile: ["Profile"],
      "growth-tools": ["Growth Tools", "Business Starter Hub", "Hub"],
    };

    const labels = labelsByView[view];

    for (const label of labels) {
      const direct = page.getByRole("link", { name: new RegExp(escapeRegex(label), "i") }).first();
      if (await direct.isVisible().catch(() => false)) {
        await direct.click();
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await page.waitForTimeout(800);
        return;
      }

      const loose = page.locator("a").filter({ hasText: new RegExp(escapeRegex(label), "i") }).first();
      if (await loose.isVisible().catch(() => false)) {
        await loose.click();
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await page.waitForTimeout(800);
        return;
      }
    }

    throw new Error(`Could not find the dashboard menu link for view \"${view}\". The Namecheap dashboard layout may have changed.`);
  }

  private async openAdvancedDns(page: Page, domainName: string): Promise<void> {
    const normalized = normalizeDomain(domainName);
    await page.goto(this.buildAppUrl(`/Domains/DomainControlPanel/${encodeURIComponent(normalized)}/advancedns`), {
      timeout: this.config.navigationTimeoutMs,
      waitUntil: "domcontentloaded",
    });

    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(1_000);

    const hasDomainHeading = await page
      .getByText(new RegExp(escapeRegex(normalized), "i"))
      .first()
      .isVisible()
      .catch(() => false);

    if (!hasDomainHeading) {
      throw new Error(`Could not open the Advanced DNS page for ${normalized}.`);
    }
  }

  private async extractDomains(page: Page): Promise<NamecheapDomainSummary[]> {
    const rawDomains = await page.evaluate((domainPatternSource) => {
      const domainPattern = new RegExp(domainPatternSource, "ig");

      const isVisible = (element: Element): boolean => {
        const htmlElement = element as HTMLElement;
        const style = window.getComputedStyle(htmlElement);
        const rect = htmlElement.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };

      const summarize = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 280);
      const map = new Map<string, string>();

      const registerDomain = (domain: string, summary: string): void => {
        const normalized = domain.toLowerCase();
        if (!domainPattern.test(normalized)) {
          return;
        }

        if (normalized.startsWith("window.") || normalized.includes("siteservernameurl")) {
          return;
        }

        const current = map.get(normalized);
        if (!current || summary.length < current.length) {
          map.set(normalized, summary);
        }
      };

      const domainAnchors = Array.from(document.querySelectorAll('a[href*="/DomainControlPanel/"]'));
      for (const anchor of domainAnchors) {
        if (!isVisible(anchor)) {
          continue;
        }

        const href = anchor.getAttribute("href") ?? "";
        const match = href.match(/\/DomainControlPanel\/([^/?#]+)/i);
        if (!match || !match[1]) {
          continue;
        }

        const parsedDomain = decodeURIComponent(match[1]).trim().toLowerCase();
        const container = anchor.closest("tr, [role='row'], li, article, section, div") ?? anchor;
        const summary = summarize(container.textContent ?? anchor.textContent ?? parsedDomain);
        registerDomain(parsedDomain, summary);
      }

      const containers = Array.from(document.querySelectorAll("tr, [role='row'], li, article, section"));

      for (const element of containers) {
        if (!isVisible(element)) {
          continue;
        }

        const text = element.textContent?.replace(/\s+/g, " ").trim() ?? "";
        if (!text || text.length > 500) {
          continue;
        }

        const domains = text.match(domainPattern) ?? [];
        if (domains.length === 0) {
          continue;
        }

        for (const candidate of domains) {
          const normalizedCandidate = candidate.trim().toLowerCase();
          registerDomain(normalizedCandidate, summarize(text));
        }
      }

      return Array.from(map.entries()).map(([domain, summary]) => ({ domain, summary }));
    }, DOMAIN_REGEX.source);

    return rawDomains
      .filter((entry) => DOMAIN_REGEX.test(entry.domain))
      .sort((left, right) => left.domain.localeCompare(right.domain));
  }

  private async extractDashboardOptions(page: Page): Promise<NamecheapDashboardOption[]> {
    const options = await page.evaluate(() => {
      const isVisible = (element: Element): boolean => {
        const htmlElement = element as HTMLElement;
        const style = window.getComputedStyle(htmlElement);
        const rect = htmlElement.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };

      const links = Array.from(document.querySelectorAll("a[href]"));
      const collected: Array<{ label: string; href: string; section: string }> = [];
      const seen = new Set<string>();

      for (const anchor of links) {
        if (!isVisible(anchor)) {
          continue;
        }

        const label = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
        const href = (anchor as HTMLAnchorElement).href?.trim() ?? "";
        if (!label || !href || href.startsWith("javascript:")) {
          continue;
        }

        const sectionText =
          anchor.closest("nav, aside, header, [role='navigation'], ul, section")?.textContent?.slice(0, 160) ?? "";
        const section = sectionText.replace(/\s+/g, " ").trim().slice(0, 80) || "dashboard";

        const key = `${label.toLowerCase()}|${href.toLowerCase()}`;
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        collected.push({ label, href, section });
      }

      return collected;
    });

    return options.sort((left, right) => left.label.localeCompare(right.label));
  }

  private extractExpiryText(source: string): string | undefined {
    const patterns = [
      /expir(?:es|ing|ation date?)[:\s]+([a-z]{3,9}\s+\d{1,2},\s+\d{4})/i,
      /expiry[:\s]+([a-z]{3,9}\s+\d{1,2},\s+\d{4})/i,
      /expiration date[:\s]+([a-z]{3,9}\s+\d{1,2},\s+\d{4})/i,
    ];

    for (const pattern of patterns) {
      const match = source.match(pattern);
      const value = normalizeText(match?.[1]);
      if (!isEmpty(value)) {
        return value;
      }
    }

    return undefined;
  }

  private extractBooleanFeature(source: string, markers: string[]): boolean | null {
    const lowered = source.toLowerCase();

    for (const marker of markers) {
      const markerIndex = lowered.indexOf(marker.toLowerCase());
      if (markerIndex === -1) {
        continue;
      }

      const windowText = lowered.slice(markerIndex, markerIndex + 140);
      if (/\b(on|enabled|active|yes)\b/.test(windowText)) {
        return true;
      }
      if (/\b(off|disabled|inactive|no)\b/.test(windowText)) {
        return false;
      }
    }

    return null;
  }

  private async extractNameserverSettings(
    page: Page,
  ): Promise<{ mode: string; customNameservers: string[]; snippet: string }> {
    const mode = await this.readNameserverMode(page);
    const data = await page.evaluate(() => {
      const isVisible = (element: Element): boolean => {
        const htmlElement = element as HTMLElement;
        const style = window.getComputedStyle(htmlElement);
        const rect = htmlElement.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };

      const domainRegex = /(?:xn--)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z]{2,63}/i;
      const values = new Set<string>();
      const controls = Array.from(document.querySelectorAll("input, textarea, select"));

      for (const control of controls) {
        if (!isVisible(control)) {
          continue;
        }

        const htmlElement = control as HTMLElement;
        const hint = [
          htmlElement.getAttribute("name") ?? "",
          htmlElement.getAttribute("id") ?? "",
          htmlElement.getAttribute("aria-label") ?? "",
          htmlElement.getAttribute("placeholder") ?? "",
          htmlElement.closest("label")?.textContent ?? "",
          htmlElement.parentElement?.textContent ?? "",
        ]
          .join(" ")
          .toLowerCase();

        if (!/nameserver|dns server|custom dns/i.test(hint)) {
          continue;
        }

        const value =
          control instanceof HTMLSelectElement
            ? (control.selectedOptions[0]?.textContent ?? control.value ?? "")
            : control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement
              ? control.value
              : "";
        const normalized = value.trim().toLowerCase();

        if (domainRegex.test(normalized)) {
          values.add(normalized);
        }
      }

      const snippet = (document.body.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 3_000);

      return {
        customNameservers: Array.from(values),
        snippet,
      };
    });

    return {
      mode,
      customNameservers: data.customNameservers,
      snippet: data.snippet,
    };
  }

  private async applyNameserverSettings(
    page: Page,
    input: { mode: "basic" | "free" | "premium" | "custom"; nameservers: string[] },
  ): Promise<{ applied: boolean; message: string }> {
    const applied = await page.evaluate((payload) => {
      const isVisible = (element: Element): boolean => {
        const htmlElement = element as HTMLElement;
        const style = window.getComputedStyle(htmlElement);
        const rect = htmlElement.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };

      const clickModeControl = (labelCandidates: string[]): boolean => {
        const clickable = Array.from(document.querySelectorAll("label, button, a, [role='button'], [role='tab'], span"));
        for (const element of clickable) {
          if (!isVisible(element)) {
            continue;
          }

          const text = (element.textContent ?? "").replace(/\s+/g, " ").toLowerCase();
          if (labelCandidates.some((candidate) => text.includes(candidate))) {
            (element as HTMLElement).click();
            return true;
          }
        }

        const selects = Array.from(document.querySelectorAll("select"));
        for (const select of selects) {
          if (!isVisible(select)) {
            continue;
          }

          const htmlSelect = select as HTMLSelectElement;
          const options = Array.from(htmlSelect.options);
          for (const option of options) {
            const optionText = option.textContent?.toLowerCase() ?? "";
            if (labelCandidates.some((candidate) => optionText.includes(candidate))) {
              htmlSelect.value = option.value;
              htmlSelect.dispatchEvent(new Event("input", { bubbles: true }));
              htmlSelect.dispatchEvent(new Event("change", { bubbles: true }));
              return true;
            }
          }
        }

        return false;
      };

      const modeLabels: Record<string, string[]> = {
        basic: ["basicdns", "basic dns"],
        free: ["freedns", "free dns"],
        premium: ["premiumdns", "premium dns"],
        custom: ["custom dns", "custom nameserver", "custom nameservers"],
      };

      const modeApplied = clickModeControl(modeLabels[payload.mode] ?? []);
      if (!modeApplied) {
        return {
          applied: false,
          message: `Could not find a nameserver mode control for ${payload.mode}.`,
        };
      }

      if (payload.mode !== "custom") {
        return {
          applied: true,
          message: "Nameserver mode selected.",
        };
      }

      const nsInputs = Array.from(document.querySelectorAll("input, textarea")).filter((element) => {
        if (!isVisible(element)) {
          return false;
        }

        const htmlElement = element as HTMLElement;
        const hint = [
          htmlElement.getAttribute("name") ?? "",
          htmlElement.getAttribute("id") ?? "",
          htmlElement.getAttribute("aria-label") ?? "",
          htmlElement.getAttribute("placeholder") ?? "",
          htmlElement.closest("label")?.textContent ?? "",
          htmlElement.parentElement?.textContent ?? "",
        ]
          .join(" ")
          .toLowerCase();

        return /nameserver|dns server|custom dns/i.test(hint);
      }) as Array<HTMLInputElement | HTMLTextAreaElement>;

      if (nsInputs.length === 0) {
        return {
          applied: false,
          message: "Custom nameserver fields were not found after selecting Custom DNS.",
        };
      }

      for (const [index, field] of nsInputs.entries()) {
        const value = payload.nameservers[index] ?? "";
        field.focus();
        field.value = value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        field.blur();
      }

      return {
        applied: true,
        message: "Custom nameservers applied.",
      };
    }, input);

    return applied;
  }

  private async saveDomainChanges(page: Page): Promise<void> {
    await this.clickFirst(page, [
      'button:has-text("Save All Changes")',
      'button:has-text("Save Changes")',
      'button:has-text("Save")',
      'a:has-text("Save Changes")',
      'text="Save All Changes"',
      'text="Save Changes"',
      'text="Save"',
    ]);

    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(1_500);
  }

  private async extractFeatureStateFromDom(page: Page, feature: NamecheapDomainFeature): Promise<boolean | null> {
    const keywordsByFeature: Record<NamecheapDomainFeature, string[]> = {
      "auto-renew": ["auto renew", "auto-renew", "auto renewal"],
      "domain-lock": ["domain lock", "registrar lock", "transfer lock"],
      "whois-privacy": ["whois guard", "whois privacy", "privacy protection"],
    };

    const stateFromControl = await page.evaluate((keywords) => {
      const isVisible = (element: Element): boolean => {
        const htmlElement = element as HTMLElement;
        const style = window.getComputedStyle(htmlElement);
        const rect = htmlElement.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };

      const controls = Array.from(document.querySelectorAll("input[type='checkbox'], [role='switch'], button, [aria-pressed]"));

      for (const control of controls) {
        if (!isVisible(control)) {
          continue;
        }

        const htmlElement = control as HTMLElement;
        const nearbyText = [
          htmlElement.getAttribute("name") ?? "",
          htmlElement.getAttribute("id") ?? "",
          htmlElement.getAttribute("aria-label") ?? "",
          htmlElement.textContent ?? "",
          htmlElement.closest("label")?.textContent ?? "",
          htmlElement.parentElement?.textContent ?? "",
        ]
          .join(" ")
          .toLowerCase();

        if (!keywords.some((keyword) => nearbyText.includes(keyword))) {
          continue;
        }

        if (control instanceof HTMLInputElement && control.type === "checkbox") {
          return control.checked;
        }

        const ariaPressed = htmlElement.getAttribute("aria-pressed");
        if (ariaPressed === "true") return true;
        if (ariaPressed === "false") return false;

        const ariaChecked = htmlElement.getAttribute("aria-checked");
        if (ariaChecked === "true") return true;
        if (ariaChecked === "false") return false;
      }

      return null;
    }, keywordsByFeature[feature]);

    if (stateFromControl !== null) {
      return stateFromControl;
    }

    const bodyText = normalizeText(await page.locator("body").textContent().catch(() => ""));
    return this.extractBooleanFeature(bodyText, keywordsByFeature[feature]);
  }

  private async toggleDomainFeature(
    page: Page,
    input: { feature: NamecheapDomainFeature; enabled: boolean },
  ): Promise<{ found: boolean; changed: boolean }> {
    const keywordsByFeature: Record<NamecheapDomainFeature, string[]> = {
      "auto-renew": ["auto renew", "auto-renew", "auto renewal"],
      "domain-lock": ["domain lock", "registrar lock", "transfer lock"],
      "whois-privacy": ["whois guard", "whois privacy", "privacy protection"],
    };

    return page.evaluate((payload) => {
      const isVisible = (element: Element): boolean => {
        const htmlElement = element as HTMLElement;
        const style = window.getComputedStyle(htmlElement);
        const rect = htmlElement.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };

      const controls = Array.from(document.querySelectorAll("input[type='checkbox'], [role='switch'], button, [aria-pressed]"));

      for (const control of controls) {
        if (!isVisible(control)) {
          continue;
        }

        const htmlElement = control as HTMLElement;
        const nearbyText = [
          htmlElement.getAttribute("name") ?? "",
          htmlElement.getAttribute("id") ?? "",
          htmlElement.getAttribute("aria-label") ?? "",
          htmlElement.textContent ?? "",
          htmlElement.closest("label")?.textContent ?? "",
          htmlElement.parentElement?.textContent ?? "",
        ]
          .join(" ")
          .toLowerCase();

        if (!payload.keywords.some((keyword) => nearbyText.includes(keyword))) {
          continue;
        }

        let currentState: boolean | null = null;

        if (control instanceof HTMLInputElement && control.type === "checkbox") {
          currentState = control.checked;
        } else {
          const ariaPressed = htmlElement.getAttribute("aria-pressed");
          if (ariaPressed === "true") currentState = true;
          if (ariaPressed === "false") currentState = false;
          const ariaChecked = htmlElement.getAttribute("aria-checked");
          if (ariaChecked === "true") currentState = true;
          if (ariaChecked === "false") currentState = false;
        }

        const target = control instanceof HTMLInputElement ? control : htmlElement;

        if (currentState === null || currentState !== payload.enabled) {
          target.click();
          return { found: true, changed: true };
        }

        return { found: true, changed: false };
      }

      return { found: false, changed: false };
    }, {
      enabled: input.enabled,
      keywords: keywordsByFeature[input.feature],
    });
  }

  private async readNameserverMode(page: Page): Promise<string> {
    return page.evaluate(() => {
      const text = document.body.innerText.replace(/\s+/g, " ");
      if (/BasicDNS/i.test(text)) return "BasicDNS";
      if (/PremiumDNS/i.test(text)) return "PremiumDNS";
      if (/FreeDNS/i.test(text)) return "FreeDNS";
      if (/Custom DNS|custom nameservers/i.test(text)) return "Custom DNS";
      return "Unknown";
    });
  }

  private async isUsingNamecheapDns(page: Page): Promise<boolean> {
    const nameserverMode = await this.readNameserverMode(page);
    return ["BasicDNS", "PremiumDNS", "FreeDNS"].includes(nameserverMode);
  }

  private async extractDnsRecords(page: Page): Promise<NamecheapDnsRecord[]> {
    return page.evaluate(() => {
      const isBlank = (value: string | null | undefined): boolean =>
        (value ?? "").replace(/\s+/g, " ").trim().length === 0;

      const isVisible = (element: Element): boolean => {
        const htmlElement = element as HTMLElement;
        const style = window.getComputedStyle(htmlElement);
        const rect = htmlElement.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };

      const readHint = (element: Element): string => {
        const htmlElement = element as HTMLElement;
        const labelText = htmlElement.closest("label")?.textContent ?? "";
        const wrapperText = htmlElement.parentElement?.textContent ?? "";
        const aria = htmlElement.getAttribute("aria-label") ?? "";
        const placeholder = (htmlElement as HTMLInputElement).placeholder ?? "";
        const name = htmlElement.getAttribute("name") ?? "";
        return [labelText, wrapperText, aria, placeholder, name].join(" ").toLowerCase();
      };

      const readControlValue = (element: Element): string => {
        if (element instanceof HTMLSelectElement) {
          return (element.selectedOptions[0]?.textContent ?? element.value ?? "").trim();
        }
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          return element.value.trim();
        }
        return (element.textContent ?? "").trim();
      };

      const assign = (record: Record<string, string>, hint: string, value: string): void => {
        if (!value) return;
        if (!record.type && (hint.includes("type") || /^(a|aaaa|cname|txt|mx|url redirect|url frame|ns|srv|caa|alias)/i.test(value))) {
          record.type = value;
          return;
        }
        if (!record.host && (hint.includes("host") || hint.includes("name"))) {
          record.host = value;
          return;
        }
        if (!record.value && (hint.includes("value") || hint.includes("address") || hint.includes("target") || hint.includes("content"))) {
          record.value = value;
          return;
        }
        if (!record.ttl && hint.includes("ttl")) {
          record.ttl = value;
          return;
        }
        if (!record.mxPriority && (hint.includes("mx") || hint.includes("priority") || hint.includes("pref"))) {
          record.mxPriority = value;
        }
      };

      const rows = Array.from(document.querySelectorAll("tr, [role='row'], div"));
      const results: Array<{ type: string; host: string; value: string; ttl?: string; mxPriority?: string }> = [];
      const seen = new Set<string>();

      for (const row of rows) {
        if (!isVisible(row)) {
          continue;
        }

        const controls = Array.from(row.querySelectorAll("input, select, textarea, button"));
        if (controls.length < 2) {
          continue;
        }

        const record: Record<string, string> = { type: "", host: "", value: "", ttl: "", mxPriority: "" };
        for (const control of controls) {
          const hint = readHint(control);
          const value = readControlValue(control);
          assign(record, hint, value);
        }

        const text = row.textContent?.replace(/\s+/g, " ").trim() ?? "";
        if (isBlank(record.type)) {
          const match = text.match(/\b(AAAA|ALIAS|A|CNAME|TXT|MXE|MX|URL Redirect \(301\)|URL Redirect|URL Frame|NS|SRV|CAA)\b/i);
          if (match) record.type = match[1];
        }

        if (isBlank(record.host) || isBlank(record.value)) {
          const textInputs = controls.filter(
            (control) => control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement,
          ) as Array<HTMLInputElement | HTMLTextAreaElement>;

          const values = textInputs.map((control) => control.value.trim()).filter(Boolean);
          if (isBlank(record.host) && values[0]) record.host = values[0];
          if (isBlank(record.value) && values[1]) record.value = values[1];
          if (isBlank(record.ttl) && values[2]) record.ttl = values[2];
        }

        if (isBlank(record.type) || isBlank(record.host) || isBlank(record.value)) {
          continue;
        }

        const key = `${record.type}|${record.host}|${record.value}|${record.ttl}|${record.mxPriority}`;
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        results.push({
          type: normalizeText(record.type),
          host: normalizeText(record.host),
          value: normalizeText(record.value),
          ttl: isBlank(record.ttl) ? undefined : normalizeText(record.ttl),
          mxPriority: isBlank(record.mxPriority) ? undefined : normalizeText(record.mxPriority),
        });
      }

      return results;
    });
  }

  private async removeExistingHostRecords(page: Page): Promise<void> {
    const buttons = page.locator(
      '[aria-label*="Delete" i], [title*="Delete" i], button:has-text("Delete"), button:has-text("Remove"), a:has-text("Delete")',
    );

    let count = await buttons.count();
    while (count > 0) {
      await buttons.nth(0).click().catch(() => undefined);
      await page.waitForTimeout(250);
      count = await buttons.count();
    }
  }

  private async addHostRecord(page: Page, record: NamecheapDnsRecord): Promise<void> {
    await this.clickFirst(page, [
      'button:has-text("Add New Record")',
      'a:has-text("Add New Record")',
      'text="Add New Record"',
    ]);

    await page.waitForTimeout(300);

    const applied = await page.evaluate((input) => {
      const isVisible = (element: Element): boolean => {
        const htmlElement = element as HTMLElement;
        const style = window.getComputedStyle(htmlElement);
        const rect = htmlElement.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };

      const fireInput = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void => {
        element.focus();
        element.value = value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        element.blur();
      };

      const setSelectValue = (element: HTMLSelectElement, value: string): boolean => {
        const wanted = value.trim().toLowerCase();
        for (const option of Array.from(element.options)) {
          const optionText = option.textContent?.trim().toLowerCase() ?? "";
          const optionValue = option.value.trim().toLowerCase();
          if (optionText === wanted || optionValue === wanted || optionText.includes(wanted)) {
            fireInput(element, option.value);
            return true;
          }
        }
        return false;
      };

      const labelHint = (element: Element): string => {
        const htmlElement = element as HTMLElement;
        return [
          htmlElement.getAttribute("name") ?? "",
          htmlElement.getAttribute("aria-label") ?? "",
          htmlElement.getAttribute("placeholder") ?? "",
          htmlElement.closest("label")?.textContent ?? "",
          htmlElement.parentElement?.textContent ?? "",
        ]
          .join(" ")
          .toLowerCase();
      };

      const rows = Array.from(document.querySelectorAll("tr, [role='row'], div")).filter((row) => {
        if (!isVisible(row)) return false;
        const controls = row.querySelectorAll("input, select, textarea");
        if (controls.length < 2) return false;
        const blanks = Array.from(controls).filter((control) => {
          if (control instanceof HTMLSelectElement) return control.selectedIndex <= 0;
          if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) return !control.value.trim();
          return false;
        }).length;
        return blanks >= 2;
      });

      const row = rows[rows.length - 1];
      if (!row) return false;

      const controls = Array.from(row.querySelectorAll("input, select, textarea"));
      let typeControl: HTMLSelectElement | null = null;
      let hostControl: HTMLInputElement | HTMLTextAreaElement | null = null;
      let valueControl: HTMLInputElement | HTMLTextAreaElement | null = null;
      let ttlControl: HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement | null = null;
      let mxControl: HTMLInputElement | HTMLSelectElement | null = null;

      for (const control of controls) {
        const hint = labelHint(control);
        if (!typeControl && control instanceof HTMLSelectElement && hint.includes("type")) typeControl = control;
        if (!hostControl && (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) && (hint.includes("host") || hint.includes("name"))) hostControl = control;
        if (!valueControl && (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) && (hint.includes("value") || hint.includes("address") || hint.includes("target") || hint.includes("content"))) valueControl = control;
        if (!ttlControl && (hint.includes("ttl") || hint.includes("automatic"))) {
          ttlControl = control as HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement;
        }
        if (!mxControl && (hint.includes("mx") || hint.includes("priority") || hint.includes("pref"))) {
          mxControl = control as HTMLInputElement | HTMLSelectElement;
        }
      }

      const textInputs = controls.filter(
        (control): control is HTMLInputElement | HTMLTextAreaElement =>
          control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement,
      );
      const selects = controls.filter((control): control is HTMLSelectElement => control instanceof HTMLSelectElement);

      typeControl ??= selects[0] ?? null;
      hostControl ??= textInputs[0] ?? null;
      valueControl ??= textInputs[1] ?? null;
      ttlControl ??= (selects[1] as HTMLSelectElement | undefined) ?? null;
      mxControl ??= (textInputs.find((control) => control instanceof HTMLInputElement && control !== hostControl && control !== valueControl) as HTMLInputElement | undefined) ?? selects[2] ?? null;

      if (!typeControl || !hostControl || !valueControl) {
        return false;
      }

      if (!setSelectValue(typeControl, input.type)) {
        return false;
      }

      fireInput(hostControl, input.host);
      fireInput(valueControl, input.value);

      if (input.ttl && ttlControl) {
        if (ttlControl instanceof HTMLSelectElement) {
          setSelectValue(ttlControl, input.ttl);
        } else {
          fireInput(ttlControl, input.ttl);
        }
      }

      if (input.mxPriority && mxControl) {
        if (mxControl instanceof HTMLSelectElement) {
          setSelectValue(mxControl, input.mxPriority);
        } else {
          fireInput(mxControl, input.mxPriority);
        }
      }

      return true;
    }, record);

    if (!applied) {
      throw new Error(`Could not fill the DNS row for ${record.host}. The page structure may have changed and the selectors need an update.`);
    }
  }

  private async saveDnsChanges(page: Page): Promise<void> {
    await this.clickFirst(page, [
      'button:has-text("Save All Changes")',
      'button:has-text("Save Changes")',
      'a:has-text("Save All Changes")',
      'text="Save All Changes"',
    ]);

    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(1_500);
  }

  private async clickFirst(page: Page, selectors: string[]): Promise<void> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        await locator.click();
        return;
      }
    }

    throw new Error(`Could not find any clickable element for selectors: ${selectors.join(", ")}`);
  }
}
