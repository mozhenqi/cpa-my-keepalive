// =====================================================================
//  blitz.cloud 保活脚本（修复 15 分钟假活 / 缓存未穿透问题）
// =====================================================================

import { chromium } from 'playwright-core';

// ============================ 配置区 ============================
const RUN_MINUTES = 65;
const INTERVAL_SEC = 240;      // 缩短基础间隔到 4 分钟，确保 15 分钟内至少穿透 3 次
const JITTER_SEC = 45;         // 随机抖动 ±45 秒（实际 195~285 秒）
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

const ts = () => new Date().toISOString().slice(11, 19);
const isSleeping = (title, gate) =>
  SLEEP_TITLE_REGEX.test(title) || gate === 'asleep' || gate === 'waking';
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

// 给 URL 加上随机防缓存参数，强制穿透 blitz 边缘网关直达容器后端
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

// 注意：不要设置假的 Windows USER_AGENT！保持与 Linux Runner 原生最新 Chrome 一致
const context = await browser.newContext({
  locale: 'en-US',
  viewport: { width: 1366, height: 768 },
  serviceWorkers: 'block', // 阻止 Service Worker 缓存拦截请求
});

await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

const page = await context.newPage();

// 通过 CDP 彻底关闭页面级缓存
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

async function settle() {
  await page
    .waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS })
    .catch(() => console.log(`[${ts()}] networkidle timeout, continue`));
  await page.waitForTimeout(randInt(EXTRA_STAY_MS[0], EXTRA_STAY_MS[1]));
}

// 在页面内额外发一次带 no-store 的同源请求，确保后端容器收到活跃心跳
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
  console.log(`[${ts()}] status ${res?.status()} gate=${gate} title=${title}`);

  // 如果应用正常在线，发送一次防缓存心跳后结束本轮
  if (res?.status() === 200 && !isSleeping(title, gate)) {
    await sendHeartbeatPing();
    return;
  }

  // 如果处于 asleep 状态且有按钮，点击唤醒按钮
  const btn = page.getByRole('button', { name: WAKE_BUTTON_REGEX });
  if (await btn.count()) {
    console.log(`[${ts()}] asleep -> clicking wake`);
    await btn.first().click().catch((e) => console.log('click failed:', e.message));
  } else {
    // 处理 gate=waking 的情况（正在唤醒中，没有按钮，但需要等待它启动完毕）
    console.log(`[${ts()}] state is ${gate} (no wake button), waiting for container...`);
  }

  // 轮询等待应用彻底唤醒
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
      console.log(`[${ts()}] woke up, title=${await page.title()}`);
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
    console.log(`[${ts()}] error: ${e.message}`);
  }
  const waitSec = randInt(INTERVAL_SEC - JITTER_SEC, INTERVAL_SEC + JITTER_SEC);
  console.log(`[${ts()}] next visit in ${waitSec}s`);
  await page.waitForTimeout(waitSec * 1000);
}

await browser.close();
console.log(`[${ts()}] done`);
