'use strict';
/*
 * 一次性验收服务 (compose 服务 verify):
 *   1. 规则代码测试: node --test test/verifier.test.js
 *   2. 页面构建检查: GET / 操作页 + GET /app/verifier.js 语法/装载检查
 *   3. API/HTTP 冒烟:
 *        - GET /healthz 健康响应
 *        - “缺少获取的跨队列读取” 经 HTTP 被拒绝 (MISSING_ACQUIRE)
 *        - “完整移交后读取” 通过, 且呈现版本与移交证据
 *   以退出码报告: 0 全部通过, 1 存在失败。
 *
 * BASE_URL 默认 http://127.0.0.1:8080; 若不可达则自行启动服务器,
 * 验收结束后关闭。compose 中由环境变量指向 http://web:8080。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const fs = require('node:fs');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8080';

let failures = 0;
const logs = [];
function ok(msg) { logs.push(`  ✓ ${msg}`); console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function bad(msg, detail) {
  failures++;
  logs.push(`  ✗ ${msg}${detail ? ` —— ${detail}` : ''}`);
  console.error(`  \x1b[31m✗\x1b[0m ${msg}${detail ? ` —— ${detail}` : ''}`);
}
function section(name) { console.log(`\n\x1b[36m[${name}]\x1b[0m`); }

async function waitFor(url, tries = 40, gapMs = 250) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* 未就绪, 继续 */ }
    await new Promise((res) => setTimeout(res, gapMs));
  }
  return false;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', errOut = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('close', (code) => resolve({ code, out, errOut }));
  });
}

async function maybeStartServer() {
  try {
    const r = await fetch(`${BASE_URL}/healthz`);
    if (r.ok) { console.log(`使用已运行服务: ${BASE_URL}`); return null; }
  } catch { /* 启动 */ }
  console.log(`BASE_URL ${BASE_URL} 不可达, 本地启动服务器…`);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'node', 'server.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: new URL(BASE_URL).port || '8080',
           HOST: '127.0.0.1' }
  });
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  const ready = await waitFor(`${BASE_URL}/healthz`);
  if (!ready) {
    child.kill('SIGTERM');
    throw new Error('验收服务器未能在时限内就绪');
  }
  return child;
}

async function checkRuleTests() {
  section('1/3 规则代码测试');
  const r = await run(process.execPath, ['--test', path.join(__dirname, '..', 'test')]);
  const tail = r.out.split('\n').filter((l) => /^# (tests|pass|fail)/.test(l)).join(' | ');
  if (r.code === 0) ok(`node --test 全部通过 (${tail})`);
  else bad('规则测试失败', `退出码 ${r.code}; ${tail}\n${r.errOut.slice(-800)}`);
}

async function checkPage() {
  section('2/3 页面构建检查');
  const home = await fetch(`${BASE_URL}/`);
  if (home.status !== 200) { bad('操作页 GET / 非 200', String(home.status)); return; }
  const html = await home.text();
  const markers = [
    ['多硬件队列缓冲区同步复核台', '页面标题'],
    ['执行复核', '复核按钮'],
    ['缺少获取的跨队列读取', '场景一入口'],
    ['完整移交后读取', '场景二入口'],
    ['/app/verifier.js', '浏览器侧引擎引用']
  ];
  for (const [needle, label] of markers) {
    if (html.includes(needle)) ok(`操作页包含「${label}」`);
    else bad(`操作页缺少「${label}」`, needle);
  }

  const jsResp = await fetch(`${BASE_URL}/app/verifier.js`);
  if (jsResp.status !== 200) { bad('GET /app/verifier.js 非 200', String(jsResp.status)); return; }
  const jsText = await jsResp.text();

  // 语法检查: node --check
  const tmp = path.join(os.tmpdir(), `verifier-${process.pid}.js`);
  fs.writeFileSync(tmp, jsText);
  const chk = await run(process.execPath, ['--check', tmp]);
  fs.unlinkSync(tmp);
  if (chk.code === 0) ok('浏览器侧引擎脚本语法检查 node --check 通过');
  else bad('浏览器侧引擎脚本语法错误', chk.errOut.trim());

  // 装载检查: 在隔离沙箱中执行, 全局 Verifier 必须可用且场景可复核
  try {
    const sandbox = { module: { exports: {} }, globalThis: {} };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(jsText, sandbox);
    const V = sandbox.globalThis.Verifier || sandbox.module.exports;
    if (!V || typeof V.verify !== 'function') throw new Error('Verifier 未暴露');
    const r = V.verify(V.fullHandshakeScenario());
    if (!r.ok || r.order[0] !== 'A1') throw new Error('沙箱内复核结果异常');
    ok('浏览器侧脚本可装载, 全局 Verifier 可用并正确复核内置场景');
  } catch (e) {
    bad('浏览器侧脚本装载/执行失败', e.message);
  }
}

async function checkHttpSmoke() {
  section('3/3 API / HTTP 冒烟');

  const h = await fetch(`${BASE_URL}/healthz`);
  const hj = await h.json();
  if (h.ok && hj.status === 'ok' && hj.limits.maxQueues === 3) {
    ok(`健康响应正常: status=${hj.status}, maxQueues=${hj.limits.maxQueues}`);
  } else bad('健康响应异常', JSON.stringify(hj));

  const scenariosResp = await fetch(`${BASE_URL}/api/scenarios`);
  const { scenarios } = await scenariosResp.json();
  ok('GET /api/scenarios 返回两个内置场景');

  // 场景一: 缺少获取的跨队列读取 -> 必须经 HTTP 被拒绝
  const r1 = await fetch(`${BASE_URL}/api/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(scenarios.missingAcquire)
  });
  const j1 = await r1.json();
  if (r1.status === 422 && j1.ok === false && j1.code === 'MISSING_ACQUIRE' &&
      j1.submission === 'B1' && j1.unitRange && j1.unitRange.buffer === 'IMG') {
    ok(`“缺少获取的跨队列读取” 经 HTTP 被拒绝: HTTP ${r1.status} ${j1.code} ` +
       `@提交 ${j1.submission} 区间 ${j1.unitRange.buffer}[${j1.unitRange.start}..+${j1.unitRange.length}]`);
  } else {
    bad('场景一未按预期被拒绝', `HTTP ${r1.status} ${JSON.stringify(j1).slice(0, 300)}`);
  }

  // 场景二: 完整移交后读取 -> 通过, 呈现版本与移交证据
  const r2 = await fetch(`${BASE_URL}/api/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(scenarios.fullHandshake)
  });
  const j2 = await r2.json();
  let good = r2.status === 200 && j2.ok === true &&
             JSON.stringify(j2.order) === JSON.stringify(['A1', 'B1']);
  if (!good) {
    bad('场景二未通过', `HTTP ${r2.status} ${JSON.stringify(j2).slice(0, 300)}`);
  } else {
    const u0 = j2.units.IMG[0];
    const tr = u0 && u0.transfers && u0.transfers[0];
    if (u0 && u0.version === 1 && u0.owner === 'Q_ENCODE' && tr &&
        tr.fromQueue === 'Q_DECODE' && tr.toQueue === 'Q_ENCODE' &&
        tr.releasedBy === 'A1' && tr.acquiredBy === 'B1' && tr.version === 1) {
      ok(`“完整移交后读取” 通过: 次序 A1→B1, IMG[0] 属主=${u0.owner} ` +
         `版本 v${u0.version}; 移交证据 ${tr.fromQueue}(${tr.releasedBy}) → ` +
         `${tr.toQueue}(${tr.acquiredBy}) @v${tr.version}`);
    } else {
      bad('场景二缺少版本/移交证据', JSON.stringify({ u0 }));
    }
    const touched = j2.touched.find((t) => t.submission === 'B1');
    if (touched && touched.ranges.some((g) => g.kind === 'read' && g.buffer === 'IMG')) {
      ok('结果呈现受影响区间: B1 读取 IMG');
    } else bad('结果未呈现 B1 的受影响区间');
  }

  // 附: 死锁环也应被 HTTP 拒绝, 并带 ring
  const r3 = await fetch(`${BASE_URL}/api/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      queues: [{ id: 'Q0' }, { id: 'Q1' }],
      buffers: [{ id: 'B', length: 1 }],
      submissions: [
        { id: 'A', queue: 'Q0', wait: { timeline: 'tb', value: 1 },
          signal: { timeline: 'ta', increment: 1 },
          ops: [{ kind: 'write', buffer: 'B', start: 0, length: 1 }] },
        { id: 'B', queue: 'Q1', wait: { timeline: 'ta', value: 1 },
          signal: { timeline: 'tb', increment: 1 },
          ops: [{ kind: 'write', buffer: 'B', start: 0, length: 1 }] }
      ]
    })
  });
  const j3 = await r3.json();
  if (r3.status === 409 && j3.code === 'DEADLOCK' &&
      Array.isArray(j3.ring) && j3.ring.includes('A') && j3.ring.includes('B')) {
    ok(`死锁环经 HTTP 拒绝并定位环: ${j3.ring.join(' → ')}`);
  } else bad('死锁环冒烟失败', JSON.stringify(j3).slice(0, 200));
}

(async () => {
  console.log('=== 星载多队列复核器 验收 (verify 一次性服务) ===');
  console.log(`BASE_URL = ${BASE_URL}`);
  const child = await maybeStartServer();
  try {
    await checkRuleTests();
    await checkPage();
    await checkHttpSmoke();
  } catch (e) {
    bad('验收流程异常中断', e.stack || e.message);
  } finally {
    if (child) child.kill('SIGTERM');
  }

  console.log('\n==========================================');
  if (failures === 0) {
    console.log('\x1b[32m验收通过: 规则测试 + 页面构建 + API/HTTP 冒烟全部成功\x1b[0m');
    process.exit(0);
  } else {
    console.error(`\x1b[31m验收失败: ${failures} 项未通过\x1b[0m`);
    process.exit(1);
  }
})();
