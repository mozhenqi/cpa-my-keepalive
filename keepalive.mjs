import { chromium } from 'playwright-core';

const url = process.env.TARGET_URL;
if (!url) {
  console.error('TARGET_URL is empty');
  process.exit(1);
}

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();

let ok = false;
for (let i = 1; i <= 4 && !ok; i++) {
  try {
    const res = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(3000);
    const status = res?.status();
    console.log(`try ${i}: status ${status}, title: ${await page.title()}`);
    ok = status === 200;
  } catch (e) {
    console.log(`try ${i}: ${e.message}`);
  }
  if (!ok) await page.waitForTimeout(15000);
}

await browser.close();
process.exit(ok ? 0 : 1);
