'use strict';

// 页面构建检查：不依赖浏览器，校验 HTML 关键结构与内联脚本可编译（语法检查）
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function run() {
  const htmlPath = path.join(__dirname, '..', 'src', 'public', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const failures = [];
  const check = (cond, msg) => { if (!cond) failures.push(msg); };

  check(/<!DOCTYPE html>/i.test(html), '缺少 DOCTYPE');
  check(/<title>[^<]+<\/title>/.test(html), '缺少标题');
  check(/id="verifyBtn"/.test(html), '缺少复核按钮');
  check(/id="queueList"/.test(html), '缺少队列录入区');
  check(/id="bufferList"/.test(html), '缺少缓冲区录入区');
  check(/id="submissionList"/.test(html), '缺少提交录入区');
  check(/id="result"/.test(html), '缺少结果区');
  check(/\/api\/verify/.test(html), '未接入 /api/verify');
  check(/\/api\/scenarios/.test(html), '未接入 /api/scenarios');
  check(/缺少获取的跨队列读取/.test(html), '缺少标准场景一入口');
  check(/完整移交后读取/.test(html), '缺少标准场景二入口');
  check(/MAX_BUFFER_LEN:\s*64/.test(html), '未体现 64 单元上限');
  check(/MAX_SUBMISSIONS:\s*48/.test(html), '未体现 48 提交上限');
  check(/MAX_QUEUES:\s*3/.test(html), '未体现 3 队列上限');

  const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  check(scripts.length > 0, '缺少内联脚本');
  scripts.forEach((code, i) => {
    try {
      new vm.Script(code, { filename: `index-inline-${i}.js` });
    } catch (e) {
      failures.push(`内联脚本 ${i} 语法错误: ${e.message}`);
    }
  });

  // 结果渲染入口必须存在且被按钮绑定
  check(/function\s+verifyPage\s*\(/.test(html), '缺少 verifyPage 入口');
  check(/function\s+renderResult\s*\(/.test(html), '缺少 renderResult 入口');
  check(/getElementById\('verifyBtn'\)\.onclick\s*=\s*verifyPage/.test(html), '复核按钮未绑定 verifyPage');

  // 复核须在 Web Worker 中执行，失败时回退 HTTP API
  check(/new\s+Worker\(['"]\/verifier\/worker\.js['"]\)/.test(html), '未创建 /verifier/worker.js Worker');
  check(/w\.postMessage\(\{\s*input\s*\}\)/.test(html), 'Worker 未接收 input 消息');
  check(/verifyViaApi/.test(html), '缺少 HTTP API 回退路径');

  if (failures.length) {
    console.error('✗ 页面构建检查失败:');
    failures.forEach((f) => console.error(`  - ${f}`));
    return 1;
  }
  console.log(`✓ 页面构建检查通过（${scripts.length} 段内联脚本均可编译，关键结构齐全）`);
  return 0;
}

if (require.main === module) process.exit(run());
module.exports = { run };
