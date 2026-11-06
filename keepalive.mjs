import { chromium } from 'playwright-core';

const url = process.env.TARGET_URL;
if (!url) {
  console.error('TARGET_URL is empty');
  process.exit(1);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false, // 配合 xvfb-run，避免 HeadlessChrome 特征
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});

const context = await browser.newContext({
  userAgent: UA,
  locale: 'en-US',
  viewport: { width: 1366, height: 768 },
});
const page = await context.newPage();

// 去掉 navigator.webdriver 标记
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

let ok = false;
for (let i = 1; i <= 6 && !ok; i++) {
  try {
    const res = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    // 模拟一点真人行为
    await page.mouse.move(300 + i * 10, 300);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(5000);

    const status = res?.status();
    const headers = res ? res.headers() : {};
    const body = (await page.content()).slice(0, 800);

    console.log(`try ${i}: status ${status}, title: ${await page.title()}`);
    console.log('headers:', JSON.stringify(headers));
    console.log('body:', body);

    ok = status === 200;
  } catch (e) {
    console.log(`try ${i}: ${e.message}`);
  }
  if (!ok) await page.waitForTimeout(30000);
}

await browser.close();
process.exit(ok ? 0 : 1);
