'use strict';
/*
 * HTTP 服务: 零依赖 (node:http)。
 *   GET  /                 -> 操作页 (public/index.html)
 *   GET  /healthz          -> 健康响应
 *   GET  /api/scenarios    -> 两个内置规范场景
 *   POST /api/verify       -> 复核引擎
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const verifier = require('../core/verifier.js');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new verifier.VerificationError(verifier.ERROR_CODES.BAD_REQUEST,
          '请求体超过 1MiB 上限'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function errorToResponse(err) {
  const statusByCode = {
    LIMIT_EXCEEDED: 422,
    BAD_REQUEST: 400,
    UNMET_WAIT: 409,
    DEADLOCK: 409,
    OUT_OF_ORDER: 422,
    WRONG_OWNER: 422,
    MISSING_ACQUIRE: 422,
    STALE_VERSION: 422
  };
  const status = statusByCode[err.code] || 500;
  return { status, body: {
    ok: false,
    code: err.code || 'INTERNAL',
    message: err.message,
    submission: err.submission || null,
    queue: err.queue || null,
    unitRange: err.unitRange || null,
    wait: err.wait || null,
    ring: err.ring || null
  } };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function serveStatic(res, urlPath) {
  // /app/* 映射到浏览器侧脚本目录(src/core), 其它映射到 public/
  let filePath;
  if (urlPath === '/') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  } else if (urlPath.startsWith('/app/')) {
    const rel = urlPath.slice('/app/'.length).replace(/^\/+/, '');
    filePath = path.normalize(path.join(__dirname, '..', 'core', rel));
    const coreDir = path.normalize(path.join(__dirname, '..', 'core'));
    if (!filePath.startsWith(coreDir)) {
      sendJson(res, 403, { ok: false, code: 'FORBIDDEN', message: 'forbidden' });
      return;
    }
    return serveFile(res, filePath);
  } else {
    filePath = path.normalize(path.join(PUBLIC_DIR, urlPath.replace(/^\/+/, '')));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      sendJson(res, 403, { ok: false, code: 'FORBIDDEN', message: 'forbidden' });
      return;
    }
  }
  serveFile(res, filePath);
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND',
        message: `${path.basename(filePath)} 不存在` });
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'content-length': data.length
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/') {
      return serveStatic(res, '/');
    }
    if (req.method === 'GET' && p.startsWith('/app/')) {
      return serveStatic(res, p);
    }
    if (req.method === 'GET' && (p === '/healthz' || p === '/health')) {
      return sendJson(res, 200, {
        status: 'ok',
        service: 'satellite-queue-verifier',
        uptimeSeconds: Math.round(process.uptime()),
        limits: {
          maxQueues: verifier.MAX_QUEUES,
          maxBuffers: verifier.MAX_BUFFERS,
          maxUnitsPerBuffer: verifier.MAX_UNITS,
          maxSubmissions: verifier.MAX_SUBMISSIONS
        }
      });
    }
    if (req.method === 'GET' && p === '/api/scenarios') {
      return sendJson(res, 200, {
        scenarios: {
          missingAcquire: verifier.missingAcquireScenario(),
          fullHandshake: verifier.fullHandshakeScenario()
        }
      });
    }
    if (req.method === 'POST' && p === '/api/verify') {
      const raw = await readBody(req);
      let model;
      try {
        model = JSON.parse(raw || '{}');
      } catch (e) {
        return sendJson(res, 400, {
          ok: false, code: verifier.ERROR_CODES.BAD_REQUEST,
          message: `JSON 解析失败: ${e.message}`
        });
      }
      try {
        const result = verifier.verify(model);
        return sendJson(res, 200, result);
      } catch (err) {
        const r = errorToResponse(err);
        return sendJson(res, r.status, r.body);
      }
    }
    if (req.method === 'GET' && p === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: `未知路径 ${p}` });
  } catch (err) {
    const r = errorToResponse(err);
    sendJson(res, r.status, r.body);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[verifier] listening on http://${HOST}:${PORT}`);
});

module.exports = { server };
