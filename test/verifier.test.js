'use strict';
/*
 * 复核引擎规则测试 —— node:test / node:assert, 零第三方依赖。
 * 覆盖: 容量限制、队列顺序、无满足来源等待、死锁环、
 *       缺少获取的跨队列读取、完整移交后读取(版本+移交证据)、
 *       过期版本读取、错误所有者、未初始化读取。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const V = require('../src/core/verifier.js');
const { verify, ERROR_CODES,
        missingAcquireScenario, fullHandshakeScenario } = V;

function expectReject(model, code) {
  let err;
  try { verify(model); } catch (e) { err = e; }
  assert.ok(err, '应当抛出拒绝');
  assert.equal(err.code, code, `错误码期望 ${code}, 实际 ${err.code} (${err.message})`);
  return err;
}

test('场景一: 缺少获取的跨队列读取 必须被拒绝', () => {
  const err = expectReject(missingAcquireScenario(), ERROR_CODES.MISSING_ACQUIRE);
  assert.equal(err.submission, 'B1');
  assert.equal(err.queue, 'Q_ENCODE');
  assert.deepEqual(err.unitRange, { buffer: 'IMG', start: 0, length: 8 });
});

test('场景二: 完整移交后读取 通过, 并呈现版本与移交证据', () => {
  const r = verify(fullHandshakeScenario());
  assert.equal(r.ok, true);
  assert.deepEqual(r.order, ['A1', 'B1']);
  const img = r.units['IMG'];
  for (let u = 0; u < 8; u++) {
    assert.equal(img[u].owner, 'Q_ENCODE', `unit ${u} owner`);
    assert.equal(img[u].version, 1, `unit ${u} version`);
    const tr = img[u].transfers[0];
    assert.ok(tr, `unit ${u} 有移交证据`);
    assert.equal(tr.fromQueue, 'Q_DECODE');
    assert.equal(tr.toQueue, 'Q_ENCODE');
    assert.equal(tr.releasedBy, 'A1');
    assert.equal(tr.acquiredBy, 'B1');
    assert.equal(tr.version, 1);
  }
  // 受影响区间
  const touchedB = r.touched.find((t) => t.submission === 'B1');
  assert.ok(touchedB.ranges.some((g) => g.kind === 'read' && g.buffer === 'IMG'));
});

test('队列顺序: 同队列内先读后写未初始化 => OUT_OF_ORDER', () => {
  expectReject({
    queues: [{ id: 'Q0' }], buffers: [{ id: 'B', length: 4 }],
    submissions: [
      { id: 'R', queue: 'Q0', ops: [{ kind: 'read', buffer: 'B', start: 0, length: 1 }] }
    ]
  }, ERROR_CODES.OUT_OF_ORDER);
});

test('同队列写后读合法, 读到最新写版本', () => {
  const r = verify({
    queues: [{ id: 'Q0' }], buffers: [{ id: 'B', length: 2 }],
    submissions: [
      { id: 'W', queue: 'Q0', ops: [{ kind: 'write', buffer: 'B', start: 0, length: 2 }] },
      { id: 'R', queue: 'Q0', ops: [{ kind: 'read', buffer: 'B', start: 0, length: 2 }] }
    ]
  });
  assert.deepEqual(r.order, ['W', 'R']);
  assert.equal(r.units['B'][0].version, 1);
});

test('无满足来源的等待 => UNMET_WAIT', () => {
  const err = expectReject({
    queues: [{ id: 'Q0' }], buffers: [{ id: 'B', length: 1 }],
    submissions: [
      { id: 'W1', queue: 'Q0',
        ops: [{ kind: 'write', buffer: 'B', start: 0, length: 1 }] },
      { id: 'W2', queue: 'Q0', wait: { timeline: 'none', value: 1 },
        ops: [{ kind: 'read', buffer: 'B', start: 0, length: 1 }] }
    ]
  }, ERROR_CODES.UNMET_WAIT);
  assert.equal(err.submission, 'W2');
});

test('等待值超过时间线总增量 => UNMET_WAIT', () => {
  expectReject({
    queues: [{ id: 'Q0' }], buffers: [{ id: 'B', length: 1 }],
    submissions: [
      { id: 'W1', queue: 'Q0', signal: { timeline: 't', increment: 1 },
        ops: [{ kind: 'write', buffer: 'B', start: 0, length: 1 }] },
      { id: 'W2', queue: 'Q0', wait: { timeline: 't', value: 2 },
        ops: [{ kind: 'read', buffer: 'B', start: 0, length: 1 }] }
    ]
  }, ERROR_CODES.UNMET_WAIT);
});

test('循环等待 => DEADLOCK, 且给出环', () => {
  const err = expectReject({
    queues: [{ id: 'Q0' }, { id: 'Q1' }],
    buffers: [{ id: 'B', length: 1 }],
    submissions: [
      { id: 'A', queue: 'Q0',
        wait: { timeline: 'tb', value: 1 },
        signal: { timeline: 'ta', increment: 1 },
        ops: [{ kind: 'write', buffer: 'B', start: 0, length: 1 }] },
      { id: 'B', queue: 'Q1',
        wait: { timeline: 'ta', value: 1 },
        signal: { timeline: 'tb', increment: 1 },
        ops: [{ kind: 'write', buffer: 'B', start: 0, length: 1 }] }
    ]
  }, ERROR_CODES.DEADLOCK);
  assert.ok(Array.isArray(err.ring) && err.ring.length >= 2, '环至少包含两个提交');
  assert.ok(err.ring.includes('A') && err.ring.includes('B'));
});

test('跨队列写(无所有权) => WRONG_OWNER', () => {
  expectReject({
    queues: [{ id: 'Q0' }, { id: 'Q1' }],
    buffers: [{ id: 'B', length: 2 }],
    submissions: [
      { id: 'A', queue: 'Q0',
        ops: [{ kind: 'write', buffer: 'B', start: 0, length: 2 }] },
      { id: 'B', queue: 'Q1',
        ops: [{ kind: 'write', buffer: 'B', start: 0, length: 2 }] }
    ]
  }, ERROR_CODES.WRONG_OWNER);
});

test('只有 release+signal 没有 acquire 的跨队列读 => MISSING_ACQUIRE', () => {
  expectReject({
    queues: [{ id: 'Q0' }, { id: 'Q1' }],
    buffers: [{ id: 'B', length: 4 }],
    submissions: [
      { id: 'A', queue: 'Q0', signal: { timeline: 't', increment: 1 },
        ops: [{ kind: 'write', buffer: 'B', start: 0, length: 4 },
               { kind: 'release', buffer: 'B', start: 0, length: 4 }] },
      { id: 'B', queue: 'Q1', wait: { timeline: 't', value: 1 },
        ops: [{ kind: 'read', buffer: 'B', start: 2, length: 2 }] }
    ]
  }, ERROR_CODES.MISSING_ACQUIRE);
});

test('过期版本/所有者保护: 移交完成后原队列再写 => WRONG_OWNER', () => {
  // release 后、被 acquire 之前, 所有权仍属原队列; 一旦读者 acquire,
  // 原队列再写即为错误所有者。
  expectReject({
    queues: [{ id: 'Q0' }, { id: 'Q1' }],
    buffers: [{ id: 'B', length: 2 }],
    submissions: [
      { id: 'A1', queue: 'Q0', signal: { timeline: 't', increment: 1 },
        ops: [{ kind: 'write', buffer: 'B', start: 0, length: 2 },
               { kind: 'release', buffer: 'B', start: 0, length: 2 }] },
      { id: 'B1', queue: 'Q1', wait: { timeline: 't', value: 1 },
        ops: [{ kind: 'acquire', buffer: 'B', start: 0, length: 2 }] },
      { id: 'A2', queue: 'Q0',
        ops: [{ kind: 'write', buffer: 'B', start: 0, length: 2 }] }
    ]
  }, ERROR_CODES.WRONG_OWNER);
});

test('release 后被获取前原队列再次写, 会撤销待获取移交; 读者获取 => MISSING_ACQUIRE', () => {
  expectReject({
    queues: [{ id: 'Q0' }, { id: 'Q1' }],
    buffers: [{ id: 'B', length: 2 }],
    submissions: [
      { id: 'A1', queue: 'Q0', signal: { timeline: 't', increment: 1 },
        ops: [{ kind: 'write', buffer: 'B', start: 0, length: 2 },
               { kind: 'release', buffer: 'B', start: 0, length: 2 }] },
      { id: 'A2', queue: 'Q0',
        ops: [{ kind: 'write', buffer: 'B', start: 0, length: 2 }] },
      { id: 'B1', queue: 'Q1', wait: { timeline: 't', value: 1 },
        ops: [{ kind: 'acquire', buffer: 'B', start: 0, length: 2 }] }
    ]
  }, ERROR_CODES.MISSING_ACQUIRE);
});

test('过期版本读取: 凭旧移交证据读已被新移交覆盖的单元 => STALE_VERSION', () => {
  // Q0 写 v1 -> release -> Q1 acquire+读(回写 v2)->release ->
  // Q0 acquire 成为新属主; Q1 若再用其旧证据读 => 过期。
  // 实现中 transfers 会追加新移交, Q1 的旧 transfer 版本 v1 != 当前 v2。
  const model = {
    queues: [{ id: 'Q0' }, { id: 'Q1' }],
    buffers: [{ id: 'B', length: 1 }],
    submissions: [
      { id: 'A1', queue: 'Q0', signal: { timeline: 'go1', increment: 1 },
        ops: [{ kind: 'write', buffer: 'B', start: 0, length: 1 },
               { kind: 'release', buffer: 'B', start: 0, length: 1 }] },
      { id: 'B1', queue: 'Q1', wait: { timeline: 'go1', value: 1 },
        signal: { timeline: 'back', increment: 1 },
        ops: [{ kind: 'acquire', buffer: 'B', start: 0, length: 1 },
               { kind: 'read', buffer: 'B', start: 0, length: 1 },
               { kind: 'write', buffer: 'B', start: 0, length: 1 },
               { kind: 'release', buffer: 'B', start: 0, length: 1 }] },
      { id: 'A2', queue: 'Q0', wait: { timeline: 'back', value: 1 },
        signal: { timeline: 'go2', increment: 1 },
        ops: [{ kind: 'acquire', buffer: 'B', start: 0, length: 1 },
               { kind: 'write', buffer: 'B', start: 0, length: 1 }] },
      // B2: Q1 持有的是 v1 旧移交证据, 单元已被 Q0 取得并写到 v3
      // => 过期版本读取
      { id: 'B2', queue: 'Q1',
        ops: [{ kind: 'read', buffer: 'B', start: 0, length: 1 }] }
    ]
  };
  const err = expectReject(model, ERROR_CODES.STALE_VERSION);
  assert.equal(err.submission, 'B2');
  assert.equal(err.unitRange.buffer, 'B');
});

test('非属主 release => WRONG_OWNER', () => {
  expectReject({
    queues: [{ id: 'Q0' }, { id: 'Q1' }], buffers: [{ id: 'B', length: 1 }],
    submissions: [
      { id: 'A', queue: 'Q0', ops: [{ kind: 'write', buffer: 'B', start: 0, length: 1 }] },
      { id: 'B', queue: 'Q1', ops: [{ kind: 'release', buffer: 'B', start: 0, length: 1 }] }
    ]
  }, ERROR_CODES.WRONG_OWNER);
});

test('无 release 的 acquire => MISSING_ACQUIRE', () => {
  expectReject({
    queues: [{ id: 'Q0' }, { id: 'Q1' }], buffers: [{ id: 'B', length: 1 }],
    submissions: [
      { id: 'A', queue: 'Q0', signal: { timeline: 't', increment: 1 },
        ops: [{ kind: 'write', buffer: 'B', start: 0, length: 1 }] },
      { id: 'B', queue: 'Q1', wait: { timeline: 't', value: 1 },
        ops: [{ kind: 'acquire', buffer: 'B', start: 0, length: 1 }] }
    ]
  }, ERROR_CODES.MISSING_ACQUIRE);
});

test('容量限制: 第 4 条队列 / 第 17 个缓冲区 / 第 49 个提交', () => {
  expectReject({
    queues: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    buffers: [], submissions: []
  }, ERROR_CODES.LIMIT_EXCEEDED);

  expectReject({
    queues: [{ id: 'q' }],
    buffers: Array.from({ length: 17 }, (_, i) => ({ id: 'B' + i, length: 1 })),
    submissions: []
  }, ERROR_CODES.LIMIT_EXCEEDED);

  expectReject({
    queues: [{ id: 'q' }], buffers: [{ id: 'B', length: 1 }],
    submissions: Array.from({ length: 49 }, (_, i) => ({
      id: 'S' + i, queue: 'q',
      ops: [{ kind: 'write', buffer: 'B', start: 0, length: 1 }]
    }))
  }, ERROR_CODES.LIMIT_EXCEEDED);
});

test('缓冲区长度超过 64 单元 => LIMIT_EXCEEDED', () => {
  expectReject({
    queues: [{ id: 'q' }],
    buffers: [{ id: 'B', length: 65 }],
    submissions: []
  }, ERROR_CODES.LIMIT_EXCEEDED);
});

test('三队列完整流水线: 解码→校正→编码 全部通过, 次序满足信号量', () => {
  const r = verify({
    queues: [{ id: 'Q_DEC' }, { id: 'Q_CORR' }, { id: 'Q_ENC' }],
    buffers: [{ id: 'IMG', length: 32 }],
    submissions: [
      { id: 'DEC1', queue: 'Q_DEC', signal: { timeline: 'dec', increment: 1 },
        ops: [{ kind: 'write', buffer: 'IMG', start: 0, length: 32 },
               { kind: 'release', buffer: 'IMG', start: 0, length: 32 }] },
      { id: 'COR1', queue: 'Q_CORR', wait: { timeline: 'dec', value: 1 },
        signal: { timeline: 'corr', increment: 1 },
        ops: [{ kind: 'acquire', buffer: 'IMG', start: 0, length: 32 },
               { kind: 'read', buffer: 'IMG', start: 0, length: 32 },
               { kind: 'write', buffer: 'IMG', start: 0, length: 32 },
               { kind: 'release', buffer: 'IMG', start: 0, length: 32 }] },
      { id: 'ENC1', queue: 'Q_ENC', wait: { timeline: 'corr', value: 1 },
        ops: [{ kind: 'acquire', buffer: 'IMG', start: 0, length: 32 },
               { kind: 'read', buffer: 'IMG', start: 0, length: 32 }] }
    ]
  });
  assert.deepEqual(r.order, ['DEC1', 'COR1', 'ENC1']);
  assert.equal(r.units['IMG'][31].version, 2);
  assert.equal(r.units['IMG'][31].owner, 'Q_ENC');
});

test('release/acquire 都在但缺少信号量先后关系 => MISSING_ACQUIRE', () => {
  // 跨队列: 仅凭录入顺序的执行巧合不构成证据, 必须有 timeline wait 边。
  const err = expectReject({
    queues: [{ id: 'Q0' }, { id: 'Q1' }], buffers: [{ id: 'B', length: 1 }],
    submissions: [
      { id: 'A', queue: 'Q0',
        ops: [{ kind: 'write', buffer: 'B', start: 0, length: 1 },
               { kind: 'release', buffer: 'B', start: 0, length: 1 }] },
      { id: 'B', queue: 'Q1',
        ops: [{ kind: 'acquire', buffer: 'B', start: 0, length: 1 },
               { kind: 'read', buffer: 'B', start: 0, length: 1 }] }
    ]
  }, ERROR_CODES.MISSING_ACQUIRE);
  assert.equal(err.submission, 'B');
});

test('拓扑顺序尊重信号量: 不相关提交可交错, 有等待边的严格先后', () => {
  const r = verify({
    queues: [{ id: 'Q0' }, { id: 'Q1' }], buffers: [{ id: 'B', length: 1 }],
    submissions: [
      { id: 'P', queue: 'Q1', ops: [] },
      { id: 'A', queue: 'Q0', signal: { timeline: 't', increment: 1 },
        ops: [{ kind: 'write', buffer: 'B', start: 0, length: 1 }] },
      { id: 'C', queue: 'Q1', wait: { timeline: 't', value: 1 }, ops: [] }
    ]
  });
  assert.ok(r.order.indexOf('A') < r.order.indexOf('C'));
});
