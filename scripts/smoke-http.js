'use strict';

// API/HTTP 冒烟：健康响应、操作页可达、
// “缺少获取的跨队列读取”被拒绝、“完整移交后读取”通过且呈现版本与移交证据
const { spawn } = require('node:child_process');
const path = require('node:path');
const scenarios = require('../src/scenarios');

const BASE = process.env.BASE_URL || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(base, method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（如 HTML） */ }
  return { status: res.status, json, text };
}

async function waitForHealth(base, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await request(base, 'GET', '/health');
      if (r.status === 200 && r.json && r.json.status === 'ok') return;
    } catch { /* 尚未就绪 */ }
    await wait(250);
  }
  throw new Error(`服务在 ${tries} 次尝试后仍未就绪: ${base}/health`);
}

async function runChecks(base) {
  const failures = [];
  const check = (cond, msg) => {
    if (cond) console.log(`  ✓ ${msg}`);
    else { console.error(`  ✗ ${msg}`); failures.push(msg); }
  };

  console.log('[1] 健康响应 GET /health');
  const h = await request(base, 'GET', '/health');
  check(h.status === 200, `HTTP 200（实际 ${h.status}）`);
  check(h.json && h.json.status === 'ok', `status=ok（实际 ${h.json && h.json.status}）`);

  console.log('[2] 操作页 GET /');
  const page = await request(base, 'GET', '/');
  check(page.status === 200, `HTTP 200（实际 ${page.status}）`);
  check(page.text.includes('跨队列缓冲区同步复核'), '页面包含复核台标题');

  console.log('[3] 场景接口 GET /api/scenarios');
  const scn = await request(base, 'GET', '/api/scenarios');
  check(scn.status === 200 && scn.json && scn.json.missingAcquire && scn.json.completeTransfer,
    '返回 missingAcquire 与 completeTransfer 两个场景');

  console.log('[3b] Worker 引擎静态资源 GET /verifier/worker.js');
  const wjs = await request(base, 'GET', '/verifier/worker.js');
  check(wjs.status === 200 && wjs.text.includes('importScripts'), 'worker.js 可访问并调用 importScripts');
  const eng = await request(base, 'GET', '/verifier/engine.js');
  check(eng.status === 200 && eng.text.includes('self.analyze'), 'engine.js 可访问并暴露 self.analyze');

  console.log('[4] “缺少获取的跨队列读取”必须被拒绝');
  const bad = await request(base, 'POST', '/api/verify', scenarios.missingAcquire.input);
  check(bad.status === 422, `HTTP 422（实际 ${bad.status}）`);
  check(bad.json && bad.json.ok === false && bad.json.code === 'MISSING_ACQUIRE',
    `code=MISSING_ACQUIRE（实际 ${bad.json && bad.json.code}）`);
  check(bad.json && bad.json.submissionId === 'E1', '定位首个违规提交 E1');
  check(bad.json && bad.json.buffer === 'frameA' && bad.json.start === 0 && bad.json.end === 8,
    '给出受影响单元范围 frameA[0..7]');

  console.log('[5] “完整移交后读取”必须通过并呈现版本与移交证据');
  const good = await request(base, 'POST', '/api/verify', scenarios.completeTransfer.input);
  check(good.status === 200, `HTTP 200（实际 ${good.status}）`);
  check(good.json && good.json.ok === true, 'ok=true');
  const order = good.json && good.json.executableOrder.map((x) => x.id).join(',');
  check(order === 'D1,E1', `可执行次序 D1 → E1（实际 ${order}）`);
  const read = good.json && good.json.affectedRanges.E1.reads[0];
  check(!!read && read.start === 0 && read.end === 8, '受影响区间 frameA[0..7]');
  check(!!read && read.version === 1, '读取版本 v1');
  check(!!read && read.evidence && read.evidence.releaseBy === 'D1' && read.evidence.acquireBy === 'E1'
    && read.evidence.via && read.evidence.via.kind === 'semaphore',
    '呈现完整移交证据（releaseBy=D1, acquireBy=E1, via=semaphore）');
  check(!!(good.json && good.json.transfers.length === 1), '移交记录 1 段 frameA[0..7]');

  return failures;
}

async function main() {
  let child = null;
  let base = BASE;
  if (!base) {
    const port = 3100 + Math.floor(Math.random() * 200);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => process.stderr.write(d));
  }
  try {
    await waitForHealth(base);
    const failures = await runChecks(base);
    if (failures.length) {
      console.error(`\n冒烟失败：${failures.length} 项`);
      process.exitCode = 1;
    } else {
      console.log('\n冒烟全部通过');
    }
  } catch (e) {
    console.error(`冒烟异常: ${e.stack || e}`);
    process.exitCode = 1;
  } finally {
    if (child) child.kill('SIGTERM');
  }
}

main();
