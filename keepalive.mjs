// =====================================================================
//  blitz.cloud 保活脚本（运行在 GitHub Actions 里）
//  作用：用真实浏览器定时访问你的应用，应用休眠时自动点击 "Wake it up"
// =====================================================================

import { chromium } from 'playwright-core';

// ============================ 配置区（常改的都在这） ============================

// 【单次运行时长，分钟】
// 规则：要略大于 Cloudflare Cron 的触发周期，这样新任务触发时旧任务还在跑，中间不会断档。
//   Cron 每 30 分钟 → 建议 35
//   Cron 每 1 小时  → 建议 65
//   Cron 每 2 小时  → 建议 125
// 同时要小于 workflow 里的 timeout-minutes（见 keepalive.yml）。
const RUN_MINUTES = 65;

// 【基础访问间隔，秒】
// blitz 免费版 15 分钟（900 秒）无访问就休眠，所以这里要远小于 900。
const INTERVAL_SEC = 300;

// 【随机抖动，秒】
// 实际间隔 = INTERVAL_SEC ± JITTER_SEC 之间的随机值。
// 例：300 与 60 → 每次间隔在 240~360 秒之间随机。
// 注意：INTERVAL_SEC + JITTER_SEC + 单次访问耗时（约 40 秒）必须明显小于 900。
const JITTER_SEC = 60;

// 【唤醒后最多等待多久，秒】
const WAKE_TIMEOUT_SEC = 120;

// 【每隔多少秒轮询一次唤醒状态】
const WAKE_POLL_SEC = 5;

// 【等待网络空闲的最长时间，毫秒】
// 页面有长连接时永远不会"空闲"，超时后直接继续，不影响结果。
const NETWORK_IDLE_TIMEOUT_MS = 30000;

// 【网络空闲后额外停留的时间，毫秒】范围 [最小, 最大]，每次随机取值
const EXTRA_STAY_MS = [4000, 9000];

// 【页面加载超时，毫秒】
const PAGE_TIMEOUT_MS = 60000;

// 【休眠页识别】标题里出现这些词就认为应用在休眠或正在唤醒
const SLEEP_TITLE_REGEX = /asleep|waking/i;

// 【唤醒按钮的文字】
const WAKE_BUTTON_REGEX = /wake it up/i;

// 【浏览器伪装的 User-Agent】
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ============================ 配置区结束，下面不用改 ============================

// 目标网址从 GitHub Secrets 读取（TARGET_URL），不要写死在代码里，避免公开泄露
const url = process.env.TARGET_URL;
if (!url) {
  console.error('TARGET_URL is empty（请在仓库 Settings → Secrets 里添加）');
  process.exit(1);
}

// 当前时间（UTC，时:分:秒），用于日志
const ts = () => new Date().toISOString().slice(11, 19);
const isSleeping = (title) => SLEEP_TITLE_REGEX.test(title);

// 在 [min, max] 之间取随机整数
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

// 使用 runner 自带的 Chrome（channel: 'chrome'），不用下载浏览器
// headless: false 配合 workflow 里的 xvfb-run
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});

// 被 GitHub 取消（下一个整点任务顶替）时，优雅关闭浏览器后退出
const shutdown = async (signal) => {
  console.log(`[${ts()}] received ${signal}, closing browser`);
  await browser.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const context = await browser.newContext({
  userAgent: USER_AGENT,
  locale: 'en-US',
  viewport: { width: 1366, height: 768 },
});
const page = await context.newPage();

// 隐藏 navigator.webdriver 自动化标记
await page.addInitScript(() =>
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
);

// 等待页面所有网络请求结束，再随机多停留几秒
async function settle() {
  await page
    .waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS })
    .catch(() => console.log(`[${ts()}] networkidle timeout, continue`));
  await page.waitForTimeout(randInt(EXTRA_STAY_MS[0], EXTRA_STAY_MS[1]));
}

// 打开页面：优先等网络空闲，失败则退回到 load 事件
async function openPage() {
  const res = await page
    .goto(url, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS })
    .catch(() => page.goto(url, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS }));
  await settle();
  return res;
}

// 一次完整的访问：打开页面 → 如果在休眠就点按钮并等待醒来
async function visit() {
  const res = await openPage();
  const title = await page.title();
  const gate = res?.headers()['x-blitz-gate'] || '-';
  console.log(`[${ts()}] status ${res?.status()} gate=${gate} title=${title}`);

  if (!isSleeping(title)) return; // 应用醒着，本轮结束

  const btn = page.getByRole('button', { name: WAKE_BUTTON_REGEX });
  if (!(await btn.count())) {
    console.log(`[${ts()}] asleep, but no wake button found`);
    return;
  }

  console.log(`[${ts()}] asleep -> clicking wake`);
  await btn.first().click().catch((e) => console.log('click failed:', e.message));

  // 轮询等待应用醒来
  const tries = Math.ceil(WAKE_TIMEOUT_SEC / WAKE_POLL_SEC);
  for (let i = 0; i < tries; i++) {
    await page.waitForTimeout(WAKE_POLL_SEC * 1000);
    const r = await page.reload({ waitUntil: 'load', timeout: PAGE_TIMEOUT_MS }).catch(() => null);
    const t = await page.title().catch(() => '');
    if (r?.status() === 200 && !isSleeping(t)) {
      await settle();
      console.log(`[${ts()}] woke up, title=${await page.title()}`);
      return;
    }
  }
  console.log(`[${ts()}] wake timed out`);
}

// 模拟页面内的随机操作：移动鼠标、滚动
async function idleActions() {
  await page.mouse.move(randInt(150, 900), randInt(150, 600), { steps: randInt(5, 15) });
  await page.mouse.wheel(0, randInt(80, 300));
}

// 主循环：在 RUN_MINUTES 内，每隔 INTERVAL_SEC ± JITTER_SEC 访问一次
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
