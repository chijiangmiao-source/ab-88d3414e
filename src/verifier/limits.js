'use strict';

// 操作页录入上限（硬性约束，提交前先做结构性校验）
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') Object.assign(root, api);
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const LIMITS = Object.freeze({
    MAX_QUEUES: 3, // 至多三条硬件队列
    MAX_BUFFERS: 16, // 至多十六个缓冲区
    MAX_BUFFER_LEN: 64, // 每个缓冲区长度不超过 64 个单元
    MAX_SUBMISSIONS: 48 // 至多 48 个提交
  });

  return { LIMITS };
});
