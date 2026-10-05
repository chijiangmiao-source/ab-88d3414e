'use strict';

// UMD：Node（require）与浏览器 Web Worker（importScripts）共用
(function (root, factory) {
  const deps = typeof module !== 'undefined' && module.exports ? require('./limits') : root;
  const api = factory(deps);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') Object.assign(root, api);
})(typeof self !== 'undefined' ? self : globalThis, function (deps) {
const LIMITS = deps.LIMITS;

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isPosInt = (v) => Number.isInteger(v) && v >= 1 && v <= LIMITS.MAX_BUFFER_LEN;

// 校验操作页录入结构；返回错误消息数组（空数组表示结构合法）
function validateInput(input) {
  const errors = [];
  const fail = (msg) => errors.push(msg);

  if (!input || typeof input !== 'object') return ['根节点必须是对象'];

  const queues = input.queues;
  if (!Array.isArray(queues) || queues.length === 0) {
    fail('queues 必须是非空数组');
  } else if (queues.length > LIMITS.MAX_QUEUES) {
    fail(`队列数量超过上限 ${LIMITS.MAX_QUEUES}`);
  }

  const queueNames = new Set();
  if (Array.isArray(queues)) {
    for (const q of queues) {
      if (!isNonEmptyString(q)) fail('队列名必须是非空字符串');
      else if (queueNames.has(q)) fail(`队列名重复: ${q}`);
      else queueNames.add(q);
    }
  }

  const buffers = input.buffers;
  if (!Array.isArray(buffers) || buffers.length === 0) {
    fail('buffers 必须是非空数组');
  } else if (buffers.length > LIMITS.MAX_BUFFERS) {
    fail(`缓冲区数量超过上限 ${LIMITS.MAX_BUFFERS}`);
  }

  const bufferNames = new Set();
  if (Array.isArray(buffers)) {
    for (const b of buffers) {
      if (!b || typeof b !== 'object' || !isNonEmptyString(b.name)) {
        fail('缓冲区必须含非空字符串 name');
        continue;
      }
      if (bufferNames.has(b.name)) {
        fail(`缓冲区名重复: ${b.name}`);
        continue;
      }
      bufferNames.add(b.name);
      if (!isPosInt(b.length)) {
        fail(`缓冲区 ${b.name} 的 length 必须是 1..${LIMITS.MAX_BUFFER_LEN} 的整数`);
      }
    }
  }

  const submissions = input.submissions;
  if (!Array.isArray(submissions)) {
    fail('submissions 必须是数组');
  } else if (submissions.length > LIMITS.MAX_SUBMISSIONS) {
    fail(`提交数量超过上限 ${LIMITS.MAX_SUBMISSIONS}`);
  }

  if (!Array.isArray(submissions) || !queueNames.size || !bufferNames.size) {
    return errors; // 结构已损坏，后续逐提交校验没有意义
  }

  const submissionIds = new Set();
  submissions.forEach((s, i) => {
    const where = `submissions[${i}]`;
    if (!s || typeof s !== 'object') return fail(`${where} 必须是对象`);
    if (!isNonEmptyString(s.id)) fail(`${where}.id 必须是非空字符串`);
    else if (submissionIds.has(s.id)) fail(`提交 id 重复: ${s.id}`);
    else submissionIds.add(s.id);
    if (!queueNames.has(s.queue)) fail(`${where}.queue 未在 queues 中声明: ${s.queue}`);

    // 可选的时间线信号量：提交开始前等待（值），提交完成后递增（+1）
    if (s.wait !== undefined && s.wait !== null) {
      if (!isNonEmptyString(s.wait.semaphore)) fail(`${where}.wait.semaphore 必须是非空字符串`);
      if (!Number.isInteger(s.wait.value) || s.wait.value < 1) {
        fail(`${where}.wait.value 必须是 >=1 的整数`);
      }
    }
    if (s.signal !== undefined && s.signal !== null) {
      if (!isNonEmptyString(s.signal.semaphore)) fail(`${where}.signal.semaphore 必须是非空字符串`);
    }

    const ops = s.operations;
    if (!Array.isArray(ops) || ops.length === 0) {
      fail(`${where}.operations 必须是非空数组`);
      return;
    }
    ops.forEach((op, j) => {
      const at = `${where}.operations[${j}]`;
      const allowed = ['read', 'write', 'release', 'acquire'];
      if (!op || typeof op !== 'object' || !allowed.includes(op.type)) {
        return fail(`${at}.type 必须是 ${allowed.join('/')}`);
      }
      if (!bufferNames.has(op.buffer)) return fail(`${at}.buffer 未声明: ${op.buffer}`);
      if (!Number.isInteger(op.offset) || op.offset < 0) {
        return fail(`${at}.offset 必须是非负整数`);
      }
      if (!Number.isInteger(op.length) || op.length < 1) {
        return fail(`${at}.length 必须是正整数`);
      }
      const buf = buffers.find((x) => x.name === op.buffer);
      if (buf && isPosInt(buf.length) && op.offset + op.length > buf.length) {
        fail(`${at} 区间 [${op.offset}, ${op.offset + op.length}) 超出缓冲区 ${op.buffer} 长度 ${buf.length}`);
      }
    });
  });

  return errors;
}

  return { validateInput };
});
