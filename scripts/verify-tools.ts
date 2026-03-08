import path from "node:path";
import { NamecheapClient, type NamecheapConfig, type NamecheapDomainFeature } from "../src/namecheap-client.js";

function buildConfig(): NamecheapConfig {
  const userDataDir = process.env.NAMECHEAP_USER_DATA_DIR?.trim() || path.resolve(".namecheap-profile");
  return {
    baseUrl: process.env.NAMECHEAP_BASE_URL?.trim() || "https://www.namecheap.com",
    loginUrl: process.env.NAMECHEAP_LOGIN_URL?.trim() || "https://www.namecheap.com/myaccount/login/",
    accountUrl: process.env.NAMECHEAP_ACCOUNT_URL?.trim() || "https://ap.www.namecheap.com/",
    userDataDir,
    browserExecutablePath: process.env.NAMECHEAP_BROWSER_EXECUTABLE_PATH?.trim() || undefined,
    headless: process.env.NAMECHEAP_HEADLESS === "true",
    slowMo: 0,
    navigationTimeoutMs: Number(process.env.NAMECHEAP_NAVIGATION_TIMEOUT_MS ?? "30000"),
  };
}

function pickDomain(domains: Array<{ domain: string }>): string {
  const candidate = domains
    .map((entry) => entry.domain)
    .find((domain) => !domain.startsWith("window.") && domain.includes("."));

  if (!candidate) {
    throw new Error("No valid domain found for verification.");
  }

  return candidate;
}

async function run(): Promise<void> {
  const client = new NamecheapClient(buildConfig());

  try {
    const status = await client.getStatus();
    const dashboardOptions = await client.listDashboardOptions();
    const dashboardQuery = await client.queryView({ view: "domains" });
    const domains = await client.listDomains();
    const domainName = pickDomain(domains);
    const overview = await client.getDomainOverview(domainName);
    const nameservers = await client.getNameserverSettings(domainName);
    const features = await client.getDomainFeatureStates(domainName);
    const dnsRecords = await client.getDnsRecords(domainName);

    const nameserverSetResult = await client.setNameservers({
      domainName,
      mode:
        nameservers.mode === "Custom DNS"
          ? "custom"
          : nameservers.mode === "PremiumDNS"
            ? "premium"
            : nameservers.mode === "FreeDNS"
              ? "free"
              : "basic",
      nameservers: nameservers.mode === "Custom DNS" ? nameservers.customNameservers : undefined,
    });

    const autoRenewState = features.states.find((entry) => entry.feature === "auto-renew");
    let featureSetResult: unknown = { skipped: true };

    if (autoRenewState?.enabled !== null) {
      featureSetResult = await client.setDomainFeature({
        domainName,
        feature: "auto-renew" satisfies NamecheapDomainFeature,
        enabled: autoRenewState.enabled,
      });
    }

    const output = {
      status,
      dashboardOptionsCount: dashboardOptions.length,
      dashboardQuery,
      domainsCount: domains.length,
      domainName,
      overview,
      nameservers,
      features,
      dnsRecordCount: dnsRecords.records.length,
      nameserverSetResult,
      featureSetResult,
    };

    console.log(JSON.stringify(output, null, 2));
  } finally {
    await client.close();
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
