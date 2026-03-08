import { chromium } from "playwright";

async function testChromiumOnly() {
  console.log("Testing Chromium with --headless=old...");
  
  const browser = await chromium.launch({
    headless: true,
    args: ['--headless=old', '--disable-gpu', '--disable-software-rasterizer'],
  });
  
  console.log("✓ Browser launched");
  
  const context = await browser.newContext();
  const page = await context.newPage();
  
  console.log("✓ Page created");
  
  await page.goto("https://www.namecheap.com", { timeout: 30000 });
  
  console.log("✓ Navigation successful");
  console.log(`  URL: ${page.url()}`);
  console.log(`  Title: ${await page.title()}`);
  
  await browser.close();
  console.log("✓ Browser closed");
}

testChromiumOnly().catch(e => {
  console.error("✗ Failed:", e);
  process.exit(1);
});
