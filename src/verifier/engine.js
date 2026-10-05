'use strict';

// 星载图像处理器 跨队列缓冲区同步/所有权移交 复核引擎
//
// 偏序来源：
//   1. 同一队列内提交按录入顺序先后（队列顺序边）
//   2. 提交等待时间线信号量值 v：递增到该值的那个 signal 提交必须先于它（信号量边）
// 拒绝：等待无满足来源（无信号或信号值不足）、偏序成环（死锁）
// 逐单元维护：owner(属主队列) / version(最新写版本) / pending(待获取移交) / transfer(最近一次完成的移交证据)

// UMD：Node（require）与浏览器 Web Worker（importScripts）共用
(function (root, factory) {
  const deps = typeof module !== 'undefined' && module.exports ? require('./validator') : root;
  const api = factory(deps);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') Object.assign(root, api);
})(typeof self !== 'undefined' ? self : globalThis, function (deps) {
const validateInput = deps.validateInput;

function err(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

const rangeKey = (buffer, offset) => `${buffer}:${offset}`;

function cellsOf(op) {
  const out = [];
  for (let i = 0; i < op.length; i += 1) out.push({ buffer: op.buffer, offset: op.offset + i });
  return out;
}

// 合并相邻且具有相同版本/证据的单元段
function mergeSegments(segments) {
  const byBuffer = new Map();
  for (const seg of segments) {
    if (!byBuffer.has(seg.buffer)) byBuffer.set(seg.buffer, []);
    byBuffer.get(seg.buffer).push(seg);
  }
  const merged = [];
  for (const [buffer, segs] of byBuffer) {
    segs.sort((a, b) => a.start - b.start);
    let cur = null;
    for (const seg of segs) {
      const sameEvidence =
        cur &&
        cur.access === seg.access &&
        cur.version === seg.version &&
        JSON.stringify(cur.evidence || null) === JSON.stringify(seg.evidence || null);
      if (cur && seg.start <= cur.end && sameEvidence) {
        cur.end = Math.max(cur.end, seg.end);
      } else {
        if (cur) merged.push(cur);
        cur = { buffer, start: seg.start, end: seg.end, access: seg.access, version: seg.version };
        if (seg.evidence) cur.evidence = seg.evidence;
      }
    }
    if (cur) merged.push(cur);
  }
  return merged;
}

function analyze(input) {
  const structuralErrors = validateInput(input);
  if (structuralErrors.length) {
    return err('STRUCTURE_INVALID', '操作页录入不合法', { errors: structuralErrors });
  }

  const subs = input.submissions;
  const n = subs.length;

  // ---- 1. 构建时间线信号量的全局递增序列（信号量是单调时间线）----
  const signalIndexOf = new Map(); // semaphore -> 累计信号次数
  const signalerAt = new Map(); // `${semaphore}:${k}` -> 提交下标
  subs.forEach((s, i) => {
    if (s.signal && s.signal.semaphore) {
      const k = (signalIndexOf.get(s.signal.semaphore) || 0) + 1;
      signalIndexOf.set(s.signal.semaphore, k);
      signalerAt.set(`${s.signal.semaphore}:${k}`, i);
    }
  });

  // ---- 2. 构建偏序 DAG ----
  const edges = Array.from({ length: n }, () => []);
  const edgeReasons = new Map(); // "a->b" -> 证据
  const addEdge = (a, b, reason) => {
    if (a === b) return;
    const key = `${a}->${b}`;
    if (!edgeReasons.has(key)) {
      edges[a].push(b);
      edgeReasons.set(key, reason);
    }
  };

  // 2a. 同队列顺序
  const lastByQueue = new Map();
  subs.forEach((s, i) => {
    if (lastByQueue.has(s.queue)) {
      const a = lastByQueue.get(s.queue);
      addEdge(a, i, { kind: 'queue-order', queue: s.queue });
    }
    lastByQueue.set(s.queue, i);
  });

  // 2b. 信号量等待：值 v 由第 v 次 signal 满足；时间线信号量可跨队列建立先后关系
  const waitErrors = [];
  subs.forEach((s, i) => {
    if (!s.wait) return;
    const { semaphore, value } = s.wait;
    const signaler = signalerAt.get(`${semaphore}:${value}`);
    if (signaler === undefined) {
      waitErrors.push(
        err('UNSATISFIED_WAIT', `提交 ${s.id} 等待 ${semaphore}>=${value}，但该时间线从未递增到该值（无满足来源）`, {
          submissionId: s.id,
          queue: s.queue,
          semaphore,
          waitValue: value,
          available: signalIndexOf.get(semaphore) || 0
        })
      );
      return;
    }
    addEdge(signaler, i, { kind: 'semaphore', semaphore, signalValue: value, waitValue: value, sourceQueue: subs[signaler].queue });
  });
  if (waitErrors.length) return waitErrors[0];

  // ---- 3. 环检测（死锁）----
  const color = new Array(n).fill(0); // 0 白 / 1 灰 / 2 黑
  const stack = [];
  let cycleNodes = null;
  const dfs = (u) => {
    if (cycleNodes) return;
    color[u] = 1;
    stack.push(u);
    for (const v of edges[u]) {
      if (cycleNodes) return;
      if (color[v] === 0) dfs(v);
      else if (color[v] === 1) {
        const start = stack.indexOf(v);
        cycleNodes = stack.slice(start).concat(v);
        return;
      }
    }
    stack.pop();
    color[u] = 2;
  };
  for (let i = 0; i < n && !cycleNodes; i += 1) if (color[i] === 0) dfs(i);

  if (cycleNodes) {
    const ids = cycleNodes.map((i) => subs[i].id);
    const reasons = [];
    for (let k = 0; k < cycleNodes.length - 1; k += 1) {
      reasons.push({ from: subs[cycleNodes[k]].id, to: subs[cycleNodes[k + 1]].id, reason: edgeReasons.get(`${cycleNodes[k]}->${cycleNodes[k + 1]}`) });
    }
    const touched = {};
    cycleNodes.slice(0, -1).forEach((i) => {
      touched[subs[i].id] = subs[i].operations.map((op) => ({
        buffer: op.buffer,
        start: op.offset,
        end: op.offset + op.length
      }));
    });
    return err('DEADLOCK_CYCLE', `等待形成循环（死锁）: ${ids.join(' -> ')}`, {
      cycle: ids,
      edges: reasons,
      touchedRanges: touched
    });
  }

  // ---- 4. 可达性（信号量/队列顺序传递的先后关系）与拓扑可执行序 ----
  const reach = Array.from({ length: n }, () => new Set());
  const dfsReach = (u) => {
    if (reach[u].size >= 0 && reach[u].has('__done')) return reach[u];
    reach[u].add('__done');
    for (const v of edges[u]) {
      reach[u].add(v);
      dfsReach(v);
      for (const w of reach[v]) if (w !== '__done') reach[u].add(w);
    }
    return reach[u];
  };
  for (let i = 0; i < n; i += 1) dfsReach(i);
  const hb = (a, b) => a === b || reach[a].has(b);

  const indegree = new Array(n).fill(0);
  edges.forEach((vs) => vs.forEach((v) => { indegree[v] += 1; }));
  const ready = [];
  for (let i = 0; i < n; i += 1) if (indegree[i] === 0) ready.push(i);
  const schedule = [];
  while (ready.length) {
    ready.sort((a, b) => a - b); // 稳定：录入顺序优先
    const u = ready.shift();
    schedule.push(u);
    for (const v of edges[u]) {
      indegree[v] -= 1;
      if (indegree[v] === 0) ready.push(v);
    }
  }

  // ---- 5. 按可执行序逐单元模拟 ----
  const cells = new Map(); // key -> { owner, writer, version, pending, transfer }
  const getCell = (buffer, offset) => {
    const key = rangeKey(buffer, offset);
    if (!cells.has(key)) cells.set(key, { owner: null, writer: null, version: 0, pending: null, transfer: null });
    return cells.get(key);
  };

  const executed = [];
  const transfers = [];
  const summary = {};

  for (const si of schedule) {
    const s = subs[si];
    const acquired = new Set(); // 本提交内已执行 acquire 的单元
    const seg = { id: s.id, queue: s.queue, reads: [], writes: [], releases: [], acquires: [] };

    for (let oi = 0; oi < s.operations.length; oi += 1) {
      const op = s.operations[oi];
      const opRange = { buffer: op.buffer, start: op.offset, end: op.offset + op.length };

      if (op.type === 'write') {
        for (const c of cellsOf(op)) {
          const cell = getCell(c.buffer, c.offset);
          if (cell.owner !== null && cell.owner !== s.queue) {
            return err('WRONG_OWNER', `提交 ${s.id} 写 ${c.buffer}[${c.offset}]，但该单元属主为队列 ${cell.owner}`, {
              submissionId: s.id, queue: s.queue, opIndex: oi, opType: 'write',
              buffer: op.buffer, start: op.offset, end: op.offset + op.length,
              currentOwner: cell.owner, executedPrefix: executed.map((x) => x.id)
            });
          }
          cell.version += 1;
          cell.owner = s.queue;
          cell.writer = s.id;
          cell.transfer = null; // 新写使旧移交证据失效
          seg.writes.push({ ...opRange, access: 'write', version: cell.version });
        }
      } else if (op.type === 'release') {
        for (const c of cellsOf(op)) {
          const cell = getCell(c.buffer, c.offset);
          if (cell.owner !== s.queue) {
            return err('WRONG_OWNER', `提交 ${s.id} 释放 ${c.buffer}[${c.offset}]，但该单元不属队列 ${s.queue}（当前属主 ${cell.owner || '无'}）`, {
              submissionId: s.id, queue: s.queue, opIndex: oi, opType: 'release',
              buffer: op.buffer, start: op.offset, end: op.offset + op.length,
              currentOwner: cell.owner, executedPrefix: executed.map((x) => x.id)
            });
          }
          cell.pending = { releaseBy: s.id, fromQueue: s.queue, version: cell.version, releaseIndex: si };
          seg.releases.push({ ...opRange, version: cell.version });
        }
      } else if (op.type === 'acquire') {
        for (const c of cellsOf(op)) {
          const cell = getCell(c.buffer, c.offset);
          if (!cell.pending) {
            return err('MISSING_RELEASE', `提交 ${s.id} 获取 ${c.buffer}[${c.offset}]，但该单元没有待获取的释放`, {
              submissionId: s.id, queue: s.queue, opIndex: oi, opType: 'acquire',
              buffer: op.buffer, start: op.offset, end: op.offset + op.length,
              executedPrefix: executed.map((x) => x.id)
            });
          }
          if (cell.pending.version !== cell.version) {
            return err('STALE_VERSION', `提交 ${s.id} 获取 ${c.buffer}[${c.offset}] 的是过期版本 v${cell.pending.version}，当前已为 v${cell.version}`, {
              submissionId: s.id, queue: s.queue, opIndex: oi, opType: 'acquire',
              buffer: op.buffer, start: op.offset, end: op.offset + op.length,
              expectedVersion: cell.version, observedVersion: cell.pending.version,
              executedPrefix: executed.map((x) => x.id)
            });
          }
          if (!hb(cell.pending.releaseIndex, si)) {
            return err('ORDERING_MISSING', `提交 ${s.id} 获取 ${c.buffer}[${c.offset}]：释放提交 ${cell.pending.releaseBy} 与本提交之间缺少信号量/队列顺序先后关系`, {
              submissionId: s.id, queue: s.queue, opIndex: oi, opType: 'acquire',
              buffer: op.buffer, start: op.offset, end: op.offset + op.length,
              releaseBy: cell.pending.releaseBy,
              executedPrefix: executed.map((x) => x.id)
            });
          }
          const via = edgeReasons.get(`${cell.pending.releaseIndex}->${si}`) ||
            (hb(cell.pending.releaseIndex, si) ? { kind: 'transitive' } : null);
          const evidence = {
            fromQueue: cell.pending.fromQueue,
            toQueue: s.queue,
            version: cell.version,
            releaseBy: cell.pending.releaseBy,
            acquireBy: s.id,
            via
          };
          cell.owner = s.queue;
          cell.transfer = evidence;
          transfers.push({ buffer: c.buffer, offset: c.offset, ...evidence });
          cell.pending = null;
          acquired.add(rangeKey(c.buffer, c.offset));
          seg.acquires.push({ buffer: c.buffer, start: c.offset, end: c.offset + 1, version: cell.version, evidence });
        }
      } else {
        // read
        for (const c of cellsOf(op)) {
          const cell = getCell(c.buffer, c.offset);
          if (cell.owner === null) {
            return err('NO_OWNER', `提交 ${s.id} 读取 ${c.buffer}[${c.offset}]，该单元从未被写入（无属主、无版本）`, {
              submissionId: s.id, queue: s.queue, opIndex: oi, opType: 'read',
              buffer: op.buffer, start: op.offset, end: op.offset + op.length,
              executedPrefix: executed.map((x) => x.id)
            });
          }
          let evidence = null;
          if (cell.owner !== s.queue) {
            // 跨队列读：释放 + 信号量先后 + 获取 三类证据必须完整匹配
            if (!cell.pending) {
              return err('MISSING_RELEASE', `提交 ${s.id} 跨队列读取 ${c.buffer}[${c.offset}]：属主队列 ${cell.owner} 未释放该单元`, {
                submissionId: s.id, queue: s.queue, opIndex: oi, opType: 'read',
                buffer: op.buffer, start: op.offset, end: op.offset + op.length,
                currentOwner: cell.owner, executedPrefix: executed.map((x) => x.id)
              });
            }
            if (cell.pending.version !== cell.version) {
              return err('STALE_VERSION', `提交 ${s.id} 跨队列读取 ${c.buffer}[${c.offset}]：待移交版本 v${cell.pending.version} 已过期，当前为 v${cell.version}`, {
                submissionId: s.id, queue: s.queue, opIndex: oi, opType: 'read',
                buffer: op.buffer, start: op.offset, end: op.offset + op.length,
                expectedVersion: cell.version, observedVersion: cell.pending.version,
                executedPrefix: executed.map((x) => x.id)
              });
            }
            if (!hb(cell.pending.releaseIndex, si)) {
              return err('ORDERING_MISSING', `提交 ${s.id} 跨队列读取 ${c.buffer}[${c.offset}]：释放提交 ${cell.pending.releaseBy} 与本提交之间缺少信号量先后关系`, {
                submissionId: s.id, queue: s.queue, opIndex: oi, opType: 'read',
                buffer: op.buffer, start: op.offset, end: op.offset + op.length,
                releaseBy: cell.pending.releaseBy,
                executedPrefix: executed.map((x) => x.id)
              });
            }
            if (!acquired.has(rangeKey(c.buffer, c.offset))) {
              return err('MISSING_ACQUIRE', `提交 ${s.id} 跨队列读取 ${c.buffer}[${c.offset}]：缺少获取操作（释放与信号量先后已具备，但所有权未被获取）`, {
                submissionId: s.id, queue: s.queue, opIndex: oi, opType: 'read',
                buffer: op.buffer, start: op.offset, end: op.offset + op.length,
                currentOwner: cell.owner, releaseBy: cell.pending.releaseBy,
                executedPrefix: executed.map((x) => x.id)
              });
            }
          } else if (cell.transfer) {
            evidence = cell.transfer; // 本队列经完整移交取得，呈现移交证据
          }
          seg.reads.push({
            buffer: c.buffer, start: c.offset, end: c.offset + 1, access: 'read',
            version: cell.version, evidence
          });
        }
      }
    }

    seg.reads = mergeSegments(seg.reads);
    seg.writes = mergeSegments(seg.writes);
    seg.releases = mergeSegments(seg.releases.map((r) => ({ ...r, access: 'release' })));
    seg.acquires = mergeSegments(seg.acquires.map((a) => ({ ...a, access: 'acquire' })));
    summary[s.id] = seg;
    executed.push({ id: s.id, queue: s.queue });
  }

  const affectedRanges = {};
  Object.values(summary).forEach((seg) => {
    affectedRanges[seg.id] = {
      queue: seg.queue,
      reads: seg.reads,
      writes: seg.writes,
      releases: seg.releases,
      acquires: seg.acquires
    };
  });

  const transferSegments = mergeSegments(
    transfers.map((t) => ({
      buffer: t.buffer,
      start: t.offset,
      end: t.offset + 1,
      access: 'transfer',
      version: t.version,
      evidence: { fromQueue: t.fromQueue, toQueue: t.toQueue, releaseBy: t.releaseBy, acquireBy: t.acquireBy, via: t.via }
    }))
  );

  return {
    ok: true,
    executableOrder: executed,
    affectedRanges,
    transfers: transferSegments,
    timelines: Object.fromEntries([...signalIndexOf.entries()].map(([k, v]) => [k, { signaled: v }]))
  };
}

  return { analyze };
});

// Web Worker 消息协议（仅在 Worker realm 注册；Node 下 require 不受影响）
if (typeof self !== 'undefined' && typeof self.importScripts === 'function') {
  self.onmessage = (e) => {
    try {
      self.postMessage(self.analyze(e.data && e.data.input));
    } catch (ex) {
      self.postMessage({ ok: false, code: 'WORKER_ERROR', message: String((ex && ex.stack) || ex) });
    }
  };
}
