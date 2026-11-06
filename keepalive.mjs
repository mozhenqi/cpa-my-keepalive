// =====================================================================
//  blitz.cloud 保活脚本（公开仓库隐私脱敏 + 防缓存穿透版）
// =====================================================================

import { chromium } from 'playwright-core';

// ============================ 配置区 ============================
const RUN_MINUTES = 65;
const INTERVAL_SEC = 240;      // 基础间隔 4 分钟
const JITTER_SEC = 45;         // 随机抖动 ±45 秒
const WAKE_TIMEOUT_SEC = 120;
const WAKE_POLL_SEC = 5;
const NETWORK_IDLE_TIMEOUT_MS = 30000;
const EXTRA_STAY_MS = [5000, 10000];
const PAGE_TIMEOUT_MS = 60000;

const SLEEP_TITLE_REGEX = /asleep|waking/i;
const WAKE_BUTTON_REGEX = /wake it up/i;
// ============================ 配置区结束 ============================

const rawUrl = process.env.TARGET_URL;
if (!rawUrl) {
  console.error('TARGET_URL is empty（请在仓库 Settings → Secrets 里添加）');
  process.exit(1);
}

// 【隐私保护】通知 GitHub Actions 将 URL 和域名在日志中强制打码为 ***，防止报错信息意外泄露
console.log(`::add-mask::${rawUrl}`);
try {
  console.log(`::add-mask::${new URL(rawUrl).host}`);
} catch {}

const ts = () => new Date().toISOString().slice(11, 19);
const isSleeping = (title, gate) =>
  SLEEP_TITLE_REGEX.test(title) || gate === 'asleep' || gate === 'waking';
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

function buildBustUrl(base) {
  const u = new URL(base);
  u.searchParams.set('_t', Date.now().toString());
  return u.toString();
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-http-cache',
    '--disk-cache-size=1',
  ],
});

const shutdown = async (signal) => {
  console.log(`[${ts()}] received ${signal}, closing browser`);
  await browser.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const context = await browser.newContext({
  locale: 'en-US',
  viewport: { width: 1366, height: 768 },
  serviceWorkers: 'block',
});

await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

const page = await context.newPage();

const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

async function settle() {
  await page
    .waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS })
    .catch(() => console.log(`[${ts()}] networkidle timeout, continue`));
  await page.waitForTimeout(randInt(EXTRA_STAY_MS[0], EXTRA_STAY_MS[1]));
}

async function sendHeartbeatPing() {
  await page
    .evaluate(async () => {
      try {
        await fetch(`/?_hb=${Date.now()}`, {
          method: 'GET',
          cache: 'no-store',
          headers: { Pragma: 'no-cache', 'Cache-Control': 'no-cache' },
        });
      } catch {}
    })
    .catch(() => {});
}

async function openPage() {
  const target = buildBustUrl(rawUrl);
  const res = await page
    .goto(target, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS })
    .catch(() => page.goto(target, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS }));
  await settle();
  return res;
}

async function visit() {
  const res = await openPage();
  const title = await page.title().catch(() => '');
  const gate = res?.headers()['x-blitz-gate'] || '-';
  const sleeping = isSleeping(title, gate);

  // 只打印状态（ONLINE 或 SLEEPING），不打印真实网页 title
  console.log(
    `[${ts()}] status ${res?.status()} gate=${gate} state=${sleeping ? 'SLEEPING' : 'ONLINE'}`
  );

  if (res?.status() === 200 && !sleeping) {
    await sendHeartbeatPing();
    return;
  }

  const btn = page.getByRole('button', { name: WAKE_BUTTON_REGEX });
  if (await btn.count()) {
    console.log(`[${ts()}] asleep -> clicking wake`);
    await btn.first().click().catch(() => console.log('click failed'));
  } else {
    console.log(`[${ts()}] state is ${gate} (no wake button), waiting for container...`);
  }

  const tries = Math.ceil(WAKE_TIMEOUT_SEC / WAKE_POLL_SEC);
  for (let i = 0; i < tries; i++) {
    await page.waitForTimeout(WAKE_POLL_SEC * 1000);
    const r = await page
      .goto(buildBustUrl(rawUrl), { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS })
      .catch(() => null);
    const t = await page.title().catch(() => '');
    const g = r?.headers()['x-blitz-gate'] || '-';
    if (r?.status() === 200 && !isSleeping(t, g)) {
      await settle();
      await sendHeartbeatPing();
      console.log(`[${ts()}] woke up, state=ONLINE`);
      return;
    }
  }
  console.log(`[${ts()}] wake timed out`);
}

async function idleActions() {
  await page.mouse.move(randInt(150, 900), randInt(150, 600), { steps: randInt(5, 15) });
  await page.mouse.wheel(0, randInt(80, 300));
}

console.log(
  `[${ts()}] start: run ${RUN_MINUTES} min, interval ${INTERVAL_SEC}s ± ${JITTER_SEC}s`
);
const endAt = Date.now() + RUN_MINUTES * 60 * 1000;

while (Date.now() < endAt) {
  try {
    await visit();
    await idleActions();
  } catch (e) {
    // 仅打印错误类型，避免错误信息中带出 URL 参数
    console.log(`[${ts()}] visit error occurred`);
  }
  const waitSec = randInt(INTERVAL_SEC - JITTER_SEC, INTERVAL_SEC + JITTER_SEC);
  console.log(`[${ts()}] next visit in ${waitSec}s`);
  await page.waitForTimeout(waitSec * 1000);
}

await browser.close();
console.log(`[${ts()}] done`);
