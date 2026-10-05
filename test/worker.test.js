'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const scenarios = require('../src/scenarios');

// 在模拟的 Web Worker 全局（self / importScripts）中加载复核引擎，
// 验证 worker.js 的消息协议：postMessage({input}) -> onmessage -> postMessage(result)
test('Worker 入口在 Worker 全局中完成偏序复核并回传结果', () => {
  const dir = path.join(__dirname, '..', 'src', 'verifier');
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.importScripts = (...names) => {
    for (const name of names) {
      const code = fs.readFileSync(path.join(dir, name), 'utf8');
      vm.runInNewContext(code, sandbox, { filename: name });
    }
  };
  vm.createContext(sandbox);
  vm.runInNewContext(
    fs.readFileSync(path.join(dir, 'worker.js'), 'utf8'),
    sandbox,
    { filename: 'worker.js' }
  );

  const messages = [];
  sandbox.self.postMessage = (m) => messages.push(m);

  assert.equal(typeof sandbox.self.analyze, 'function');
  assert.equal(typeof sandbox.self.onmessage, 'function');

  sandbox.self.onmessage({ data: { input: scenarios.missingAcquire.input } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ok, false);
  assert.equal(messages[0].code, 'MISSING_ACQUIRE');

  sandbox.self.onmessage({ data: { input: scenarios.completeTransfer.input } });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].ok, true);
  // 结果来自独立 VM realm，用 JSON 做结构化比较
  assert.deepEqual(JSON.parse(JSON.stringify(messages[1].executableOrder.map((x) => x.id))), ['D1', 'E1']);
  assert.equal(messages[1].affectedRanges.E1.reads[0].evidence.acquireBy, 'E1');
});
