import { chromium } from 'playwright-core';

const url = process.env.TARGET_URL;
if (!url) { console.error('TARGET_URL is empty'); process.exit(1); }

const RUN_MINUTES = 330;   // 单次运行时长，需小于 workflow 的 timeout-minutes
const INTERVAL_SEC = 120;  // 两次访问的间隔
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
const context = await browser.newContext({
  userAgent: UA, locale: 'en-US', viewport: { width: 1366, height: 768 },
});
const page = await context.newPage();
await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));

const isSleeping = (t) => /asleep|waking/i.test(t);
const ts = () => new Date().toISOString().slice(11, 19);

// 等所有网络请求结束；某些页面有长连接会一直不空闲，所以限时兜底
async function settle(timeout = 30000) {
  await page.waitForLoadState('networkidle', { timeout }).catch(() =>
    console.log(`[${ts()}] networkidle timeout, continue`)
  );
  await page.waitForTimeout(5000); // 再多停留几秒，让统计上报等收尾请求发完
}

async function goto() {
  const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
    .catch(async () => page.goto(url, { waitUntil: 'load', timeout: 60000 }));
  await settle();
  return res;
}

async function visit() {
  const res = await goto();
  const title = await page.title();
  const gate = res?.headers()['x-blitz-gate'] || '-';
  console.log(`[${ts()}] status ${res?.status()} gate=${gate} title=${title}`);

  if (!isSleeping(title)) return;

  const btn = page.getByRole('button', { name: /wake it up/i });
  if (!(await btn.count())) { console.log(`[${ts()}] asleep, no wake button`); return; }

  console.log(`[${ts()}] asleep -> clicking wake`);
  await btn.first().click().catch(e => console.log('click failed:', e.message));

  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(5000);
    const r = await page.reload({ waitUntil: 'load', timeout: 60000 }).catch(() => null);
    const t = await page.title().catch(() => '');
    if (r?.status() === 200 && !isSleeping(t)) {
      await settle();
      console.log(`[${ts()}] woke up, title=${await page.title()}`);
      return;
    }
  }
  console.log(`[${ts()}] wake timed out`);
}

const end = Date.now() + RUN_MINUTES * 60 * 1000;
while (Date.now() < end) {
  try {
    await visit();
    await page.mouse.move(200 + Math.random() * 400, 200 + Math.random() * 300);
    await page.mouse.wheel(0, 150);
  } catch (e) {
    console.log(`[${ts()}] error: ${e.message}`);
  }
  await page.waitForTimeout(INTERVAL_SEC * 1000);
}

await browser.close();
