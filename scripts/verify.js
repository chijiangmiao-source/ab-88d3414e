'use strict';

// 一次性验收服务 verify：
//   1) 规则代码测试（node --test）
//   2) 操作页构建检查
//   3) API/HTTP 冒烟（两种跨队列读取场景）
// 以退出码报告验收结果：0 通过 / 非 0 失败
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function runStep(name, args, env = {}) {
  return new Promise((resolve) => {
    console.log(`\n===== ${name} =====`);
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: 'inherit'
    });
    child.on('close', (code) => resolve(code || 0));
  });
}

async function main() {
  const results = [];
  results.push(['规则代码测试 (node --test)', await runStep(
    '规则代码测试',
    ['--test', 'test/']
  )]);
  results.push(['页面构建检查', await runStep(
    '页面构建检查',
    [path.join('scripts', 'check-page.js')]
  )]);
  results.push(['API/HTTP 冒烟', await runStep(
    'API/HTTP 冒烟',
    [path.join('scripts', 'smoke-http.js')]
  )]);

  console.log('\n========== 验收汇总 ==========');
  let failed = 0;
  for (const [name, code] of results) {
    const pass = code === 0;
    if (!pass) failed += 1;
    console.log(`${pass ? '✓ PASS' : '✗ FAIL'}  ${name}（exit=${code}）`);
  }
  if (failed) {
    console.error(`\n验收未通过：${failed}/${results.length} 项失败`);
    process.exit(1);
  }
  console.log('\n验收通过：规则测试、页面构建与 HTTP 冒烟均成功');
  process.exit(0);
}

main();
