'use strict';
/*
 * 星载图像处理器 —— 多硬件队列缓冲区所有权 / 同步证据复核引擎
 *
 * 模型:
 *   - 至多 3 条硬件队列, 至多 16 个缓冲区, 每个缓冲区长度 <= 64 单元。
 *   - 至多 48 个提交(submission)。每个提交归属一条队列, 可 wait / signal
 *     时间线信号量, 并按顺序携带若干操作:
 *       { kind: 'read'|'write', buffer, start, length }
 *       { kind: 'release', buffer, start, length }
 *       { kind: 'acquire', buffer, start, length }
 *
 * 偏序:
 *   1. 同一队列内, 提交按录入顺序严格先后 (queue order)。
 *   2. 提交 S 在 (timeline, value) 上等待:
 *        - 存在同 timeline 上某个按偏序早于 S 的提交 signal 到 >= value
 *          (增量信号量, signal 后时间线达到该值) => 满足;
 *        - 不存在任何提交 signal 该值             => 无满足来源 (unmet wait);
 *        - 仅能由“尚未确认早于 S”的提交满足       => 形成循环 (deadlock ring)。
 *
 * 跨队列可见性 (逐单元):
 *   - 每单元维护: owner(当前独占队列)、version(最新写版本号)、
 *     pending(待获取移交 {fromQueue, version} | null)。
 *   - read:  同队列拥有 => 合法, 必须读到本队列最新写版本;
 *            无 owner  => 首次读取未初始化内存, 拒绝;
 *            他队列拥有 => 仅当存在完整移交链 release(owner) ->
 *            (信号量或队列顺序的 happens-before) -> acquire(读者队列)
 *            且移交版本 == 当前最新写版本时才可见; 否则
 *            “缺少获取的跨队列读取 / 过期版本读取 / 错误所有者”。
 *   - write: 取得所有权(首个写者), 或本队列拥有, 或完整移交后写;
 *            写使单元 version 自增并清除 pending。
 *   - release: 仅 owner 可执行; 标记单元 pending = {fromQueue, version}。
 *   - acquire: 读者队列取得所有权, 记录 transfer 证据; pending 被消费。
 *
 * 输出:
 *   { ok: true,  order: [...submissionIds], touched: [{submission, ranges:[...]}],
 *                 timeline: [...] }
 *   { ok: false, code, message, submission, queue, unitRange:{buffer,start,length},
 *                 ring:[...] }
 */

const MAX_QUEUES = 3;
const MAX_BUFFERS = 16;
const MAX_UNITS = 64;
const MAX_SUBMISSIONS = 48;

const ERROR_CODES = Object.freeze({
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  BAD_REQUEST: 'BAD_REQUEST',
  UNMET_WAIT: 'UNMET_WAIT',
  DEADLOCK: 'DEADLOCK',
  OUT_OF_ORDER: 'OUT_OF_ORDER',
  WRONG_OWNER: 'WRONG_OWNER',
  MISSING_ACQUIRE: 'MISSING_ACQUIRE',
  STALE_VERSION: 'STALE_VERSION'
});

class VerificationError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    Object.assign(this, detail);
  }
}

function rangeKey(start, length) {
  return `${start}:${start + length}`;
}

/* ------------------------- 1. 结构校验 ------------------------- */

function validateModel(model) {
  if (!model || typeof model !== 'object') {
    throw new VerificationError(ERROR_CODES.BAD_REQUEST, '请求体必须是对象');
  }
  const queues = Array.isArray(model.queues) ? model.queues : [];
  const buffers = Array.isArray(model.buffers) ? model.buffers : [];
  const submissions = Array.isArray(model.submissions) ? model.submissions : [];

  if (queues.length === 0) {
    throw new VerificationError(ERROR_CODES.BAD_REQUEST, '至少需要一条队列');
  }
  if (queues.length > MAX_QUEUES) {
    throw new VerificationError(ERROR_CODES.LIMIT_EXCEEDED,
      `队列数量 ${queues.length} 超过上限 ${MAX_QUEUES}`);
  }
  if (buffers.length > MAX_BUFFERS) {
    throw new VerificationError(ERROR_CODES.LIMIT_EXCEEDED,
      `缓冲区数量 ${buffers.length} 超过上限 ${MAX_BUFFERS}`);
  }
  if (submissions.length > MAX_SUBMISSIONS) {
    throw new VerificationError(ERROR_CODES.LIMIT_EXCEEDED,
      `提交数量 ${submissions.length} 超过上限 ${MAX_SUBMISSIONS}`);
  }

  const queueIds = new Set();
  queues.forEach((q, i) => {
    const id = typeof q === 'string' ? q : q && q.id;
    if (!id || typeof id !== 'string') {
      throw new VerificationError(ERROR_CODES.BAD_REQUEST, `队列 #${i} 缺少 id`);
    }
    if (queueIds.has(id)) {
      throw new VerificationError(ERROR_CODES.BAD_REQUEST, `队列 id 重复: ${id}`);
    }
    queueIds.add(id);
  });

  const bufferInfo = new Map();
  buffers.forEach((b, i) => {
    const id = typeof b === 'string' ? b : b && b.id;
    const length = typeof b === 'object' && b ? b.length : (b && b.length) || MAX_UNITS;
    if (!id || typeof id !== 'string') {
      throw new VerificationError(ERROR_CODES.BAD_REQUEST, `缓冲区 #${i} 缺少 id`);
    }
    if (bufferInfo.has(id)) {
      throw new VerificationError(ERROR_CODES.BAD_REQUEST, `缓冲区 id 重复: ${id}`);
    }
    if (!Number.isInteger(length) || length <= 0 || length > MAX_UNITS) {
      throw new VerificationError(ERROR_CODES.LIMIT_EXCEEDED,
        `缓冲区 ${id} 长度 ${length} 非法 (1..${MAX_UNITS})`);
    }
    bufferInfo.set(id, length);
  });

  const subIds = new Set();
  submissions.forEach((s, i) => {
    if (!s || typeof s !== 'object') {
      throw new VerificationError(ERROR_CODES.BAD_REQUEST, `提交 #${i} 必须是对象`);
    }
    const id = s.id != null ? String(s.id) : `S${i}`;
    if (subIds.has(id)) {
      throw new VerificationError(ERROR_CODES.BAD_REQUEST, `提交 id 重复: ${id}`);
    }
    subIds.add(id);
    s.id = id;
    if (!queueIds.has(s.queue)) {
      throw new VerificationError(ERROR_CODES.BAD_REQUEST,
        `提交 ${id} 引用未知队列: ${s.queue}`);
    }
    if (s.wait !== undefined && s.wait !== null) {
      const waits = Array.isArray(s.wait) ? s.wait : [s.wait];
      for (const w of waits) {
        if (!w || typeof w.timeline !== 'string' || !Number.isInteger(w.value) || w.value <= 0) {
          throw new VerificationError(ERROR_CODES.BAD_REQUEST,
            `提交 ${id} 的 wait 必须包含 timeline 与正整数 value`);
        }
      }
      s.waits = waits.map((w) => ({ timeline: w.timeline, value: w.value }));
    } else {
      s.waits = [];
    }
    if (s.signal !== undefined && s.signal !== null) {
      const sigs = Array.isArray(s.signal) ? s.signal : [s.signal];
      for (const g of sigs) {
        if (!g || typeof g.timeline !== 'string' ||
            (g.increment !== undefined && (!Number.isInteger(g.increment) || g.increment <= 0))) {
          throw new VerificationError(ERROR_CODES.BAD_REQUEST,
            `提交 ${id} 的 signal 非法 (timeline 字符串, 可选正整数 increment)`);
        }
      }
      // 默认递增 1
      s.signals = sigs.map((g) => ({ timeline: g.timeline, increment: g.increment || 1 }));
    } else {
      s.signals = [];
    }
    if (!Array.isArray(s.ops)) {
      throw new VerificationError(ERROR_CODES.BAD_REQUEST, `提交 ${id} 缺少 ops 数组`);
    }
    s.ops.forEach((op, j) => {
      if (!op || !['read', 'write', 'release', 'acquire'].includes(op.kind)) {
        throw new VerificationError(ERROR_CODES.BAD_REQUEST,
          `提交 ${id} 操作 #${j} kind 非法`);
      }
      if (!bufferInfo.has(op.buffer)) {
        throw new VerificationError(ERROR_CODES.BAD_REQUEST,
          `提交 ${id} 操作 #${j} 引用未知缓冲区: ${op.buffer}`);
      }
      const start = op.start | 0;
      const length = op.length | 0;
      if (!Number.isInteger(op.start) || !Number.isInteger(op.length) ||
          start < 0 || length <= 0 || start + length > bufferInfo.get(op.buffer)) {
        throw new VerificationError(ERROR_CODES.BAD_REQUEST,
          `提交 ${id} 操作 ${op.kind} 区间越界: ${op.buffer}[${op.start}..+${op.length}]`);
      }
    });
  });

  return { queues: queues.map((q) => (typeof q === 'string' ? q : q.id)),
           bufferInfo, submissions };
}

/* --------------------- 2. 偏序 (队列顺序 + 信号量) --------------------- */

/*
 * 依赖边语义: dep[a] 包含 b 表示 b 必须先于 a 完成 (边 b -> a)。
 *
 * 时间线匹配: timeline 从 0 起单调递增, signal(increment) 使时间线增加。
 * wait(t, v) 要求时间线达到 v, 即至少有累计增量 >= v 的 signal 提交先于它。
 * 按录入顺序(也是稳定的信号顺序)取覆盖 v 所需的 signal 提交集合 S,
 * 为每个 g ∈ S 建立 wait -> g 的 happens-before 边; 若某条边闭合为环,
 * 说明等待只能由“反过来等待自己”的提交满足 => 死锁环。
 * 全部 signal 的增量之和仍 < v => 无满足来源。
 */
function buildOrder(v) {
  const N = v.submissions.length;
  const indexById = new Map(v.submissions.map((s, i) => [s.id, i]));

  const dep = Array.from({ length: N }, () => new Set());

  // 队列内严格顺序边
  const perQueue = new Map();
  v.queues.forEach((q) => perQueue.set(q, []));
  v.submissions.forEach((s) => perQueue.get(s.queue).push(s));
  perQueue.forEach((list) => {
    for (let i = 1; i < list.length; i++) {
      dep[indexById.get(list[i].id)].add(indexById.get(list[i - 1].id));
    }
  });

  // 每条时间线的 signal 事件(录入顺序)
  const timelineSignals = new Map();
  v.submissions.forEach((s, i) => {
    s.signals.forEach((g) => {
      if (!timelineSignals.has(g.timeline)) timelineSignals.set(g.timeline, []);
      timelineSignals.get(g.timeline).push(
        { i, increment: g.increment, sid: s.id, queue: s.queue });
    });
  });

  const waitNodes = [];
  v.submissions.forEach((s, i) => {
    s.waits.forEach((w) => waitNodes.push(
      { i, timeline: w.timeline, value: w.value, sid: s.id, queue: s.queue }));
  });

  // 无任何 signal 来源 => UNMET
  for (const wn of waitNodes) {
    if (!timelineSignals.has(wn.timeline)) {
      throw new VerificationError(ERROR_CODES.UNMET_WAIT,
        `提交 ${wn.sid} 等待 ${wn.timeline}=${wn.value}, 但时间线无任何 signal 来源`,
        { submission: wn.sid, queue: wn.queue,
          wait: { timeline: wn.timeline, value: wn.value } });
    }
  }

  // 可达性闭包 + 路径记录 (dep[a] = 前驱; 前驱闭包 reach[a])
  function computeReach() {
    const reach = Array.from({ length: N }, (_, i) => new Set([i]));
    let changed = true;
    while (changed) {
      changed = false;
      for (let a = 0; a < N; a++) {
        const ra = reach[a];
        const before = ra.size;
        for (const b of Array.from(ra)) {
          for (const p of dep[b]) ra.add(p);
        }
        if (ra.size !== before) changed = true;
      }
    }
    return reach;
  }

  // 从前驱闭包中找一条 from -> to 的具体路径(边方向 前驱->后继)
  function findPath(from, to) {
    if (from === to) return [from];
    // children 邻接
    const children = Array.from({ length: N }, () => []);
    for (let a = 0; a < N; a++) {
      for (const p of dep[a]) children[p].push(a);
    }
    const parent = new Map([[from, null]]);
    const queue = [from];
    while (queue.length) {
      const x = queue.shift();
      if (x === to) break;
      for (const c of children[x]) {
        if (!parent.has(c)) { parent.set(c, x); queue.push(c); }
      }
    }
    if (!parent.has(to)) return null;
    const path = [];
    let cur = to;
    while (cur !== null) { path.unshift(cur); cur = parent.get(cur); }
    return path;
  }

  const deadlock = (wn, pathToWait) => {
    // 环: wn 等待 g, 而 g 已(经路径)依赖 wn
    const ringIds = pathToWait.map((i) => v.submissions[i].id);
    throw new VerificationError(ERROR_CODES.DEADLOCK,
      `提交 ${wn.sid} 等待 ${wn.timeline}=${wn.value} 形成死锁环: ` +
      ringIds.concat([wn.sid]).join(' -> '),
      { submission: wn.sid, queue: wn.queue,
        wait: { timeline: wn.timeline, value: wn.value },
        ring: ringIds.concat([wn.sid]) });
  };

  // 为每个等待解析覆盖所需 signal, 建立 happens-before 边。
  // 新边可能解锁其它判断(此处覆盖集是静态的, 单遍即可, 保留不动点结构)。
  let guard = 0;
  let progress = true;
  while (progress && guard++ < N + 2) {
    progress = false;
    const reach = computeReach();

    for (const wn of waitNodes) {
      const sigs = timelineSignals.get(wn.timeline) || [];

      // 按录入顺序累计增量直到覆盖 value
      let acc = 0;
      const need = [];
      for (const g of sigs) {
        acc += g.increment;
        need.push(g);
        if (acc >= wn.value) break;
      }
      if (acc < wn.value) {
        throw new VerificationError(ERROR_CODES.UNMET_WAIT,
          `提交 ${wn.sid} 等待 ${wn.timeline}=${wn.value}, ` +
          `时间线全部 signal 仅能达到 ${acc}`,
          { submission: wn.sid, queue: wn.queue,
            wait: { timeline: wn.timeline, value: wn.value },
            capacity: acc });
      }

      for (const g of need) {
        if (g.i === wn.i) {
          throw new VerificationError(ERROR_CODES.DEADLOCK,
            `提交 ${wn.sid} 等待自身 signal 的 ${wn.timeline}=${wn.value}`,
            { submission: wn.sid, queue: wn.queue,
              wait: { timeline: wn.timeline, value: wn.value },
              ring: [wn.sid, wn.sid] });
        }
        if (reach[wn.i].has(g.i)) {
          // g 已经是 wn 的前驱(队列序或先前解析的等待), 证据已满足
          continue;
        }
        // 加入 g -> wn 之前, 若已存在 wn -> g 的路径, 该边闭合为环 => 死锁
        const backPath = findPath(wn.i, g.i);
        if (backPath) deadlock(wn, backPath);

        dep[wn.i].add(g.i);
        progress = true;
      }
    }
  }

  return { dep, indexById };
}

/* --------------------- 3. 拓扑可执行次序 --------------------- */

function topoOrder(v, dep, indexById) {
  const N = v.submissions.length;
  const indeg = new Array(N).fill(0);
  // dep[a] = a 的前驱集合 => 边 前驱 -> a
  const children = Array.from({ length: N }, () => []);
  for (let a = 0; a < N; a++) {
    for (const b of dep[a]) {
      children[b].push(a);
      indeg[a]++;
    }
  }
  // 同队列优先级 + 录入顺序: 每轮选可执行中“录入序号最小”的,
  // 保证输出稳定且符合队列严格顺序。
  const ready = [];
  for (let i = 0; i < N; i++) if (indeg[i] === 0) ready.push(i);
  const order = [];
  while (ready.length) {
    ready.sort((a, b) => a - b);
    const x = ready.shift();
    order.push(v.submissions[x].id);
    for (const c of children[x]) {
      indeg[c]--;
      if (indeg[c] === 0) ready.push(c);
    }
  }
  return order;
}

/* --------------------- 4. 逐单元所有权 / 版本 / 移交模拟 --------------------- */

function closure(edges, N) {
  const reach = Array.from({ length: N }, (_, i) => new Set([i]));
  let changed = true;
  while (changed) {
    changed = false;
    for (let a = 0; a < N; a++) {
      const ra = reach[a];
      const before = ra.size;
      for (const b of Array.from(ra)) {
        for (const p of edges[b]) ra.add(p);
      }
      if (ra.size !== before) changed = true;
    }
  }
  return reach;
}

function simulate(v, order, indexById, dep) {
  const N = v.submissions.length;
  // 完整偏序闭包(队列边 + 信号量等待边)。跨队列时两队列之间只有
  // 信号量等待边可以连通, 因此 release 在闭包中是 acquire 的前驱,
  // 即证明存在“信号量先后关系”。
  const fullReach = closure(dep, N);

  // 单元状态
  const cells = new Map(); // buffer -> [{owner, version, pending, writes:[]}]
  for (const [id, len] of v.bufferInfo) {
    cells.set(id, Array.from({ length: len }, () => ({
      owner: null,        // 当前独占队列
      version: 0,         // 最新写版本
      pending: null,      // {fromQueue, version} 待获取
      lastWriter: null,   // 最后写提交
      transfers: []       // 已完成的移交证据链
    })));
  }

  const touched = new Map(); // submission id -> ranges
  const recordTouch = (sid, op) => {
    if (!touched.has(sid)) touched.set(sid, []);
    touched.get(sid).push({
      kind: op.kind, buffer: op.buffer, start: op.start, length: op.length,
      key: rangeKey(op.start, op.length)
    });
  };

  const fail = (code, message, s, op, extra = {}) => {
    const err = new VerificationError(code, message, {
      submission: s.id, queue: s.queue,
      unitRange: { buffer: op.buffer, start: op.start, length: op.length },
      ...extra
    });
    throw err;
  };

  for (const sid of order) {
    const s = v.submissions[indexById.get(sid)];
    for (const op of s.ops) {
      const arr = cells.get(op.buffer);
      recordTouch(sid, op);
      for (let u = op.start; u < op.start + op.length; u++) {
        const cell = arr[u];
        const unitRef = { buffer: op.buffer, unit: u };

        if (op.kind === 'write') {
          if (cell.owner === null) {
            // 首次写: 取得所有权
            cell.owner = s.queue;
            cell.version = 1;
            cell.pending = null;
            cell.lastWriter = s.id;
          } else if (cell.owner === s.queue) {
            cell.version += 1;
            cell.pending = null;
            cell.lastWriter = s.id;
          } else if (cell.pending && cell.pending.fromQueue === cell.owner &&
                     cell.pending.acquiredBy === s.queue) {
            // acquire 已在本提交/先前同队列提交完成
            cell.owner = s.queue;
            cell.version += 1;
            cell.pending = null;
            cell.lastWriter = s.id;
          } else {
            fail(ERROR_CODES.WRONG_OWNER,
              `提交 ${s.id} 写 ${op.buffer}[${u}]: 单元属于队列 ${cell.owner}, ` +
              `缺少 release→signal→acquire 完整移交`,
              s, op, { unit: u, currentOwner: cell.owner, pending: cell.pending });
          }
        } else if (op.kind === 'read') {
          if (cell.owner === null) {
            fail(ERROR_CODES.OUT_OF_ORDER,
              `提交 ${s.id} 读 ${op.buffer}[${u}]: 单元尚无写者/所有者 (未初始化读取)`,
              s, op, { unit: u });
          } else if (cell.owner === s.queue) {
            // 同队列拥有: 合法; 记录读到的版本
            cell.lastRead = { by: s.id, version: cell.version };
          } else {
            // 跨队列读: 必须存在“被本队列 acquire 且版本未过期”的证据
            const tr = lastTransferFor(cell, s.queue);
            if (!tr) {
              fail(ERROR_CODES.MISSING_ACQUIRE,
                `提交 ${s.id} 跨队列读 ${op.buffer}[${u}]: 缺少获取的跨队列读取 ` +
                `(所有者 ${cell.owner}, 无 release→signal→acquire 证据)`,
                s, op, { unit: u, currentOwner: cell.owner, pending: cell.pending });
            }
            if (tr.version !== cell.version) {
              fail(ERROR_CODES.STALE_VERSION,
                `提交 ${s.id} 读 ${op.buffer}[${u}]: 过期版本读取 ` +
                `(移交版本 v${tr.version}, 最新写版本 v${cell.version})`,
                s, op, { unit: u, transferVersion: tr.version,
                         latestVersion: cell.version });
            }
            if (tr.fromQueue !== cell.owner && cell.owner !== s.queue) {
              fail(ERROR_CODES.WRONG_OWNER,
                `提交 ${s.id} 读 ${op.buffer}[${u}]: 移交来源 ${tr.fromQueue} ` +
                `与当前所有者 ${cell.owner} 不匹配`,
                s, op, { unit: u, transferFrom: tr.fromQueue,
                         currentOwner: cell.owner });
            }
            cell.lastRead = { by: s.id, version: cell.version };
          }
        } else if (op.kind === 'release') {
          if (cell.owner !== s.queue) {
            fail(ERROR_CODES.WRONG_OWNER,
              `提交 ${s.id} 释放 ${op.buffer}[${u}]: 单元不属于本队列 ` +
              `(当前所有者 ${cell.owner || '无'})`,
              s, op, { unit: u, currentOwner: cell.owner });
          }
          // 标记待获取: 记录释放时版本(读者必须读到的版本)
          cell.pending = {
            fromQueue: s.queue,
            version: cell.version,
            releasedBy: s.id,
            acquiredBy: null,
            acquiredIn: null
          };
        } else if (op.kind === 'acquire') {
          if (!cell.pending || cell.pending.fromQueue !== cell.owner) {
            fail(ERROR_CODES.MISSING_ACQUIRE,
              `提交 ${s.id} 获取 ${op.buffer}[${u}]: 无有效的待获取移交 ` +
              `(缺少前驱 release 或所有权已变更)`,
              s, op, { unit: u, currentOwner: cell.owner, pending: cell.pending });
          }
          if (cell.pending.acquiredBy && cell.pending.acquiredBy !== s.queue) {
            fail(ERROR_CODES.WRONG_OWNER,
              `提交 ${s.id} 获取 ${op.buffer}[${u}]: 单元已被队列 ` +
              `${cell.pending.acquiredBy} 获取`,
              s, op, { unit: u });
          }

          // 同步证据: 释放提交必须按偏序先于本提交。
          // 跨队列移交还要求该先后关系来自“信号量等待边”
          // (不同队列之间不存在队列顺序, 仅凭执行巧合不构成证据)。
          const sIdx = indexById.get(s.id);
          const relIdx = indexById.get(cell.pending.releasedBy);
          if (!fullReach[sIdx].has(relIdx)) {
            fail(ERROR_CODES.MISSING_ACQUIRE,
              `提交 ${s.id} 获取 ${op.buffer}[${u}]: 缺少信号量先后关系, ` +
              `无法证明 release(提交 ${cell.pending.releasedBy}) 先于 acquire`,
              s, op, { unit: u, releasedBy: cell.pending.releasedBy });
          }
          const crossQueue = cell.pending.fromQueue !== s.queue;
          // 跨队列时队列顺序边不可能连通两个队列, 因此 fullReach 中存在
          // relIdx 前驱就必然经过至少一条信号量等待边 —— 上面的检查已覆盖。

          // 完成移交: 所有权转到本队列, 保留版本证据
          const p = cell.pending;
          p.acquiredBy = s.queue;
          p.acquiredIn = s.id;
          cell.owner = s.queue;
          cell.transfers.push({
            fromQueue: p.fromQueue, releasedBy: p.releasedBy,
            toQueue: s.queue, acquiredBy: s.id, version: p.version,
            via: crossQueue ? 'semaphore' : 'queue-order'
          });
          // 保留 pending 直到本队列首次写(写时清除), 以支持“获取后读”
          cell.pending = { ...p, acquiredBy: s.queue, acquiredIn: s.id };
        }
      }
    }
  }

  return { cells, touched };
}

function lastTransferFor(cell, queue) {
  for (let i = cell.transfers.length - 1; i >= 0; i--) {
    if (cell.transfers[i].toQueue === queue) return cell.transfers[i];
  }
  // 也允许“同一提交内刚 acquire”(transfers 已压入, 这里兜底)
  return null;
}

/* --------------------- 5. 汇总证据 --------------------- */

function buildEvidence(v, sim) {
  const units = {};
  for (const [buf, arr] of sim.cells) {
    units[buf] = arr.map((c, i) => ({
      unit: i,
      owner: c.owner,
      version: c.version,
      pending: c.pending ? {
        fromQueue: c.pending.fromQueue,
        version: c.pending.version,
        releasedBy: c.pending.releasedBy,
        acquiredBy: c.pending.acquiredBy || null,
        acquiredIn: c.pending.acquiredIn || null
      } : null,
      transfers: c.transfers
    }));
  }
  const touched = [];
  for (const [sid, ops] of sim.touched) {
    // 合并相邻同 kind 区间, 便于展示
    touched.push({ submission: sid, ranges: mergeRanges(ops) });
  }
  return { units, touched };
}

function mergeRanges(ops) {
  const groups = new Map();
  const out = [];
  for (const op of ops) {
    const gk = `${op.kind}|${op.buffer}`;
    let g = groups.get(gk);
    if (!g) {
      g = { kind: op.kind, buffer: op.buffer, segments: [] };
      groups.set(gk, g);
      out.push(g);
    }
    g.segments.push({ start: op.start, length: op.length });
  }
  for (const g of out) {
    g.segments.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const seg of g.segments) {
      const last = merged[merged.length - 1];
      if (last && last.start + last.length >= seg.start) {
        const end = Math.max(last.start + last.length, seg.start + seg.length);
        last.length = end - last.start;
      } else {
        merged.push({ ...seg });
      }
    }
    g.segments = merged;
  }
  return out;
}

/* ----------------------------- 主入口 ----------------------------- */

function verify(model) {
  const v = validateModel(model);

  const { dep, indexById } = buildOrder(v);
  const order = topoOrder(v, dep, indexById);
  const sim = simulate(v, order, indexById, dep);
  const evidence = buildEvidence(v, sim);

  // 时间线终态
  const timelineFinal = {};
  for (const s of v.submissions) {
    for (const g of s.signals) {
      timelineFinal[g.timeline] = (timelineFinal[g.timeline] || 0) + g.increment;
    }
  }

  return {
    ok: true,
    order,
    touched: evidence.touched,
    units: evidence.units,
    timeline: Object.entries(timelineFinal).map(([timeline, value]) => ({ timeline, value })),
    limits: { maxQueues: MAX_QUEUES, maxBuffers: MAX_BUFFERS,
              maxUnitsPerBuffer: MAX_UNITS, maxSubmissions: MAX_SUBMISSIONS }
  };
}

/* 两个规范场景(供页面与冒烟共用) */
function missingAcquireScenario() {
  return {
    name: '缺少获取的跨队列读取',
    queues: [{ id: 'Q_DECODE' }, { id: 'Q_ENCODE' }],
    buffers: [{ id: 'IMG', length: 16 }],
    submissions: [
      { id: 'A1', queue: 'Q_DECODE',
        signal: { timeline: 'frame', increment: 1 },
        ops: [
          { kind: 'write', buffer: 'IMG', start: 0, length: 8 },
          { kind: 'release', buffer: 'IMG', start: 0, length: 8 }
        ] },
      // 只 signal 了时间线, 但编码队列没有 acquire => 跨队列读必须被拒绝
      { id: 'B1', queue: 'Q_ENCODE',
        wait: { timeline: 'frame', value: 1 },
        ops: [
          { kind: 'read', buffer: 'IMG', start: 0, length: 8 }
        ] }
    ]
  };
}

function fullHandshakeScenario() {
  return {
    name: '完整移交后读取',
    queues: [{ id: 'Q_DECODE' }, { id: 'Q_ENCODE' }],
    buffers: [{ id: 'IMG', length: 16 }],
    submissions: [
      { id: 'A1', queue: 'Q_DECODE',
        signal: { timeline: 'frame', increment: 1 },
        ops: [
          { kind: 'write', buffer: 'IMG', start: 0, length: 8 },
          { kind: 'release', buffer: 'IMG', start: 0, length: 8 }
        ] },
      { id: 'B1', queue: 'Q_ENCODE',
        wait: { timeline: 'frame', value: 1 },
        ops: [
          { kind: 'acquire', buffer: 'IMG', start: 0, length: 8 },
          { kind: 'read', buffer: 'IMG', start: 0, length: 8 }
        ] }
    ]
  };
}

const api = {
  verify, validateModel, buildOrder, topoOrder, simulate,
  missingAcquireScenario, fullHandshakeScenario,
  MAX_QUEUES, MAX_BUFFERS, MAX_UNITS, MAX_SUBMISSIONS,
  ERROR_CODES, VerificationError
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof globalThis !== 'undefined') {
  globalThis.Verifier = api;
}
