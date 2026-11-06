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
const context = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1366, height: 768 } });
const page = await context.newPage();
await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));

// 记录页面发出的所有请求，看有没有唤醒接口
page.on('request', r => console.log('REQ', r.method(), r.url().replace(/^(https?:\/\/[^/]+).*/, '$1') + new URL(r.url()).pathname));
page.on('response', r => console.log('RES', r.status(), new URL(r.url()).pathname));
page.on('console', m => console.log('CONSOLE', m.type(), m.text()));

const res = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
console.log('status', res?.status(), 'title', await page.title());

// 可见文字
console.log('--- innerText ---');
console.log((await page.innerText('body')).slice(0, 1500));

// 按钮、链接、表单
console.log('--- buttons/links/forms ---');
console.log(JSON.stringify(await page.evaluate(() => ({
  buttons: [...document.querySelectorAll('button, [role=button], input[type=submit]')].map(b => (b.innerText || b.value || '').trim()),
  links: [...document.querySelectorAll('a')].map(a => ({ t: a.innerText.trim(), h: a.getAttribute('href') })),
  forms: [...document.querySelectorAll('form')].map(f => ({ action: f.action, method: f.method })),
  scripts: [...document.querySelectorAll('script')].map(s => s.src || s.textContent.trim().slice(0, 300)),
  iframes: [...document.querySelectorAll('iframe')].map(i => i.src),
})), null, 2));

// 尝试点击疑似唤醒按钮
const btn = page.locator('button, [role=button], input[type=submit], a').filter({ hasText: /wake|start|open|resume|continue|visit/i }).first();
if (await btn.count()) {
  console.log('clicking:', (await btn.innerText().catch(() => '')).trim());
  await btn.click().catch(e => console.log('click failed:', e.message));
} else {
  console.log('no wake-like button found');
}

// 等最多 90 秒，看页面是否变成正常内容
let woke = false;
for (let i = 0; i < 18 && !woke; i++) {
  await page.waitForTimeout(5000);
  const t = await page.title();
  console.log(`wait ${(i + 1) * 5}s, title: ${t}`);
  if (!/asleep/i.test(t)) woke = true;
}
if (!woke) {
  await page.reload({ waitUntil: 'load' }).catch(() => {});
  console.log('after reload title:', await page.title());
}

await browser.close();
process.exit(woke ? 0 : 1);
