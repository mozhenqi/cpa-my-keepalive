import { chromium } from 'playwright-core';

const url = process.env.TARGET_URL;
if (!url) { console.error('TARGET_URL is empty'); process.exit(1); }

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
const context = await browser.newContext({
  userAgent: UA,
  locale: 'en-US',
  viewport: { width: 1366, height: 768 },
});
const page = await context.newPage();
await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));

const isSleeping = (t) => /asleep|waking/i.test(t);

let res = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
let title = await page.title();
console.log('first visit:', res?.status(), title);

if (isSleeping(title)) {
  const btn = page.getByRole('button', { name: /wake it up/i });
  if (await btn.count()) {
    console.log('app is asleep, clicking wake button');
    await btn.first().click().catch(e => console.log('click failed:', e.message));
  }

  let ok = false;
  for (let i = 1; i <= 24; i++) {          // 最多等 约 2 分钟
    await page.waitForTimeout(5000);
    res = await page.reload({ waitUntil: 'load', timeout: 60000 }).catch(() => null);
    title = await page.title().catch(() => '');
    const status = res?.status();
    console.log(`poll ${i}: ${status}, ${title}`);
    if (status === 200 && !isSleeping(title)) { ok = true; break; }
  }
  await browser.close();
  console.log(ok ? 'woke up OK' : 'failed to wake');
  process.exit(ok ? 0 : 1);
}

await browser.close();
console.log('app already awake');
process.exit(res?.status() === 200 ? 0 : 1);
