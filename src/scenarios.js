'use strict';

// 标准复核场景，供操作页与 HTTP 冒烟共用
const scenarios = {
  // 场景一：跨队列读取缺少获取 —— 必须被拒绝（MISSING_ACQUIRE）
  missingAcquire: {
    title: '缺少获取的跨队列读取（应拒绝）',
    input: {
      queues: ['decode-q', 'encode-q'],
      buffers: [{ name: 'frameA', length: 16 }],
      submissions: [
        {
          id: 'D1',
          queue: 'decode-q',
          signal: { semaphore: 'timeline/decode' },
          operations: [
            { type: 'write', buffer: 'frameA', offset: 0, length: 8 },
            { type: 'release', buffer: 'frameA', offset: 0, length: 8 }
          ]
        },
        {
          id: 'E1',
          queue: 'encode-q',
          wait: { semaphore: 'timeline/decode', value: 1 },
          operations: [
            // 只有信号量等待，没有 acquire 就读
            { type: 'read', buffer: 'frameA', offset: 0, length: 8 }
          ]
        }
      ]
    }
  },

  // 场景二：释放 -> 信号量 -> 获取 证据完整后读取 —— 应通过并呈现版本与移交证据
  completeTransfer: {
    title: '完整移交后读取（应通过）',
    input: {
      queues: ['decode-q', 'encode-q'],
      buffers: [{ name: 'frameA', length: 16 }],
      submissions: [
        {
          id: 'D1',
          queue: 'decode-q',
          signal: { semaphore: 'timeline/decode' },
          operations: [
            { type: 'write', buffer: 'frameA', offset: 0, length: 8 },
            { type: 'release', buffer: 'frameA', offset: 0, length: 8 }
          ]
        },
        {
          id: 'E1',
          queue: 'encode-q',
          wait: { semaphore: 'timeline/decode', value: 1 },
          operations: [
            { type: 'acquire', buffer: 'frameA', offset: 0, length: 8 },
            { type: 'read', buffer: 'frameA', offset: 0, length: 8 },
            { type: 'write', buffer: 'frameA', offset: 8, length: 4 }
          ]
        }
      ]
    }
  },

  // 场景三：同队列互相等待对方的时间线 —— 死锁环
  deadlock: {
    title: '信号量等待成环（死锁，应拒绝）',
    input: {
      queues: ['decode-q'],
      buffers: [{ name: 'frameA', length: 4 }],
      submissions: [
        {
          id: 'D1',
          queue: 'decode-q',
          wait: { semaphore: 'timeline/a', value: 1 },
          signal: { semaphore: 'timeline/b' },
          operations: [{ type: 'write', buffer: 'frameA', offset: 0, length: 2 }]
        },
        {
          id: 'D2',
          queue: 'decode-q',
          wait: { semaphore: 'timeline/b', value: 1 },
          signal: { semaphore: 'timeline/a' },
          operations: [{ type: 'write', buffer: 'frameA', offset: 2, length: 2 }]
        }
      ]
    }
  }
};

module.exports = scenarios;
