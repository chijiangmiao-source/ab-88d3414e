'use strict';

// Web Worker 入口：按顺序载入复核引擎（同目录下的 limits/validator/engine），
// 在后台线程中依据队列顺序与信号量等待建立偏序并逐单元模拟，避免阻塞操作页。
/* global importScripts */
if (typeof importScripts === 'function') {
  importScripts('limits.js', 'validator.js', 'engine.js');
}
