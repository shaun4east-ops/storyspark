#!/usr/bin/env node
/**
 * StorySpark Server
 * ─────────────────
 * Tiny Express server that proxies Replicate API calls.
 * Run: node server.js
 * Then open: http://localhost:3000
 */

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const url     = require('url');

const PORT = 3000;

// ── Helper: proxy a request to Replicate ─────────────────────────────────────
function replicateRequest(method, endpoint, token, body, res) {
  const options = {
    hostname: 'api.replicate.com',
    path:     endpoint,
    method:   method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    }
  };

  const req = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      res.writeHead(apiRes.statusCode, {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers':'Content-Type,Authorization',
      });
      res.end(data);
    });
  });

  req.on('error', (e) => {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: e.message }));
  });

  if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
  req.end();
}

// ── Helper: fetch an image URL and return as base64 ──────────────────────────
function fetchImageAsBase64(imageUrl, res) {
  const parsedUrl = new url.URL(imageUrl);
  const options = {
    hostname: parsedUrl.hostname,
    path:     parsedUrl.pathname + parsedUrl.search,
    method:   'GET',
  };

  const req = https.request(options, (imgRes) => {
    const chunks = [];
    imgRes.on('data', chunk => chunks.push(chunk));
    imgRes.on('end', () => {
      const buffer     = Buffer.concat(chunks);
      const base64     = buffer.toString('base64');
      const mimeType   = imgRes.headers['content-type'] || 'image/jpeg';
      const dataUrl    = `data:${mimeType};base64,${base64}`;
      res.writeHead(200, {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ dataUrl }));
    });
  });

  req.on('error', (e) => {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: e.message }));
  });

  req.end();
}

// ── Main server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed  = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Replicate-Token',
    });
    res.end();
    return;
  }

  // ── Serve the HTML app ────────────────────────────────────────────────────
  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'storyspark-app.html');
    if (!fs.existsSync(htmlPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('storyspark-app.html not found. Make sure it is in the same folder as server.js');
      return;
    }
    const html = fs.readFileSync(htmlPath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ── API: Test token ───────────────────────────────────────────────────────
  if (pathname === '/api/account' && req.method === 'GET') {
    const token = req.headers['x-replicate-token'];
    if (!token) { res.writeHead(400); res.end(JSON.stringify({ error: 'No token' })); return; }
    replicateRequest('GET', '/v1/account', token, null, res);
    return;
  }

  // ── API: Create prediction ────────────────────────────────────────────────
  if (pathname === '/api/predict' && req.method === 'POST') {
    const token = req.headers['x-replicate-token'];
    if (!token) { res.writeHead(400); res.end(JSON.stringify({ error: 'No token' })); return; }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      replicateRequest('POST', '/v1/predictions', token, body, res);
    });
    return;
  }

  // ── API: Poll prediction status ───────────────────────────────────────────
  if (pathname.startsWith('/api/predict/') && req.method === 'GET') {
    const token = req.headers['x-replicate-token'];
    const predId = pathname.replace('/api/predict/', '');
    if (!token || !predId) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing token or id' })); return; }
    replicateRequest('GET', `/v1/predictions/${predId}`, token, null, res);
    return;
  }

  // ── API: Fetch image as base64 ────────────────────────────────────────────
  if (pathname === '/api/image' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { imageUrl } = JSON.parse(body);
        if (!imageUrl) { res.writeHead(400); res.end(JSON.stringify({ error: 'No imageUrl' })); return; }
        fetchImageAsBase64(imageUrl, res);
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log('\n');
  console.log('  ╔════════════════════════════════════════╗');
  console.log('  ║      StorySpark Server Running!        ║');
  console.log('  ╠════════════════════════════════════════╣');
  console.log(`  ║  Open in browser:                      ║`);
  console.log(`  ║  → http://localhost:${PORT}              ║`);
  console.log('  ╠════════════════════════════════════════╣');
  console.log('  ║  Press Ctrl+C to stop                  ║');
  console.log('  ╚════════════════════════════════════════╝');
  console.log('\n');
});
