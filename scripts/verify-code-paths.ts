import { NamecheapClient } from "../src/namecheap-client.js";

const config = {
  baseUrl: process.env.NAMECHEAP_BASE_URL || "https://www.namecheap.com",
  loginUrl: process.env.NAMECHEAP_LOGIN_URL || "https://www.namecheap.com/myaccount/login/",
  accountUrl: process.env.NAMECHEAP_ACCOUNT_URL || "https://ap.www.namecheap.com/",
  userDataDir: process.env.NAMECHEAP_USER_DATA_DIR || ".namecheap-profile",
  browserExecutablePath: process.env.NAMECHEAP_BROWSER_EXECUTABLE_PATH,
  headless: process.env.NAMECHEAP_HEADLESS !== "false",
  slowMo: parseInt(process.env.NAMECHEAP_SLOW_MO || "0", 10),
  navigationTimeoutMs: parseInt(process.env.NAMECHEAP_NAVIGATION_TIMEOUT_MS || "30000", 10),
};

async function verifyCodePaths() {
  const client = new NamecheapClient(config);
  
  console.log("✓ NamecheapClient instantiated");
  
  // Test 1: Status check (will launch browser and check auth)
  console.log("\n[1/5] Testing status check...");
  try {
    const status = await client.getStatus();
    console.log(`✓ Status check completed: authenticated=${status.authenticated}`);
  } catch (e) {
    console.log(`✗ Status check failed: ${e.message}`);
    throw e;
  }
  
  // Test 2: List domains (will fail if not authenticated, but tests code path)
  console.log("\n[2/5] Testing domain list...");
  try {
    const domains = await client.listDomains();
    console.log(`✓ Domain list completed: ${domains.length} domains`);
  } catch (e) {
    if (e.message.includes("not_authenticated") || e.message.includes("login")) {
      console.log(`✓ Domain list code path works (not authenticated as expected)`);
    } else {
      console.log(`✗ Domain list failed: ${e.message}`);
      throw e;
    }
  }
  
  // Test 3: Dashboard options (tests navigation)
  console.log("\n[3/5] Testing dashboard options...");
  try {
    const options = await client.listDashboardOptions();
    console.log(`✓ Dashboard options completed: ${options.length} options`);
  } catch (e) {
    if (e.message.includes("not_authenticated") || e.message.includes("login")) {
      console.log(`✓ Dashboard options code path works (not authenticated as expected)`);
    } else {
      console.log(`✗ Dashboard options failed: ${e.message}`);
      throw e;
    }
  }
  
  // Test 4: Query dashboard (tests view navigation)
  console.log("\n[4/5] Testing dashboard query...");
  try {
    const result = await client.queryView({ view: "account" });
    console.log(`✓ Dashboard query completed: ${result.text.length} chars`);
  } catch (e) {
    if (e.message.includes("not_authenticated") || e.message.includes("login")) {
      console.log(`✓ Dashboard query code path works (not authenticated as expected)`);
    } else {
      console.log(`✗ Dashboard query failed: ${e.message}`);
      throw e;
    }
  }
  
  // Test 5: Browser launch stability
  console.log("\n[5/5] Testing browser stability (3 launches)...");
  for (let i = 1; i <= 3; i++) {
    try {
      const status = await client.getStatus();
      console.log(`✓ Launch ${i}/3 successful`);
    } catch (e) {
      console.log(`✗ Launch ${i}/3 failed: ${e.message}`);
      throw e;
    }
  }
  
  console.log("\n✓ All code paths verified successfully!");
  console.log("\nNote: Full feature verification requires authenticated session.");
  console.log("To test with auth: import cookies with x-ncpl-auth, x-auth-recall, x-auth-deviceverification");
}

verifyCodePaths().catch((e) => {
  console.error("\n✗ Verification failed:", e);
  process.exit(1);
});
