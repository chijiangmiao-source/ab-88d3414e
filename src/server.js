'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { analyze } = require('./verifier/engine');
const { validateInput } = require('./verifier/validator');
const scenarios = require('./scenarios');

const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'space-image-queue-reviewer', time: new Date().toISOString() });
});

// 两个标准读取场景，供操作页一键载入与冒烟使用
app.get('/api/scenarios', (_req, res) => {
  res.json(Object.fromEntries(Object.entries(scenarios).map(([k, v]) => [k, v.input])));
});

app.post('/api/verify', (req, res) => {
  const structuralErrors = validateInput(req.body);
  if (structuralErrors.length) {
    return res.status(400).json({ ok: false, code: 'STRUCTURE_INVALID', message: '操作页录入不合法', errors: structuralErrors });
  }
  const result = analyze(req.body);
  if (!result.ok) return res.status(422).json(result);
  res.json(result);
});

app.use(express.static(path.join(__dirname, 'public')));
// 供操作页 Web Worker 载入复核引擎（/verifier/worker.js）
app.use('/verifier', express.static(path.join(__dirname, 'verifier')));

// JSON 解析错误等兜底
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, code: 'BAD_JSON', message: '请求体不是合法 JSON' });
  }
  res.status(500).json({ ok: false, code: 'INTERNAL', message: String(err && err.message) });
});

const server = http.createServer(app);
const port = Number(process.env.PORT) || 3000;

if (require.main === module) {
  server.listen(port, () => {
    console.log(`[reviewer] 操作页 http://0.0.0.0:${port}/  健康检查 http://0.0.0.0:${port}/health`);
  });
}

module.exports = { app, server };
