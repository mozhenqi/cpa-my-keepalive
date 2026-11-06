import { chromium } from 'playwright';

const url = process.env.TARGET_URL;
const browser = await chromium.launch();
const page = await browser.newPage();
let ok = false;
for (let i = 1; i <= 4 && !ok; i++) {
  try {
    const res = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(3000);
    console.log(`try ${i}: status ${res?.status()}`);
    ok = res?.status() === 200;
  } catch (e) {
    console.log(`try ${i}: ${e.message}`);
  }
  if (!ok) await page.waitForTimeout(15000);
}
await browser.close();
process.exit(ok ? 0 : 1);
