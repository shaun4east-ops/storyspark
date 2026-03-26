// StorySpark Server — pure Node.js, no npm dependencies needed
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = process.env.PORT || 3000;

// Temp image store — holds uploaded photos so Replicate can fetch them via URL
const tempImages = new Map();
let imgCounter = 0;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function httpsRequest(options, bodyBuf) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    if (bodyBuf && bodyBuf.length) req.write(bodyBuf);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    setCors(res); res.writeHead(204); res.end(); return;
  }

  try {

    // ── 1. Replicate API proxy ─────────────────────────────
    // Routes /replicate/* → api.replicate.com/*
    if (pathname.startsWith('/replicate/')) {
      const replicatePath = pathname.replace('/replicate', '');
      const bodyBuf = await readBody(req);
      const options = {
        hostname: 'api.replicate.com',
        path: replicatePath,
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': req.headers['authorization'] || '',
          'User-Agent': 'StorySpark/1.0',
        },
      };
      if (bodyBuf.length) options.headers['Content-Length'] = bodyBuf.length;
      const r = await httpsRequest(options, bodyBuf);
      setCors(res);
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(r.body);
      return;
    }

    // ── 2. Upload image → get public URL for Replicate ─────
    // Replicate models need a real URL, not base64
    if (pathname === '/upload' && req.method === 'POST') {
      const bodyBuf = await readBody(req);
      let dataUrl;
      try { dataUrl = JSON.parse(bodyBuf.toString()).dataUrl; } catch(e) {}
      if (!dataUrl || !dataUrl.startsWith('data:')) {
        setCors(res); res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid dataUrl' })); return;
      }
      const id = `${Date.now()}_${++imgCounter}`;
      tempImages.set(id, dataUrl);
      setTimeout(() => tempImages.delete(id), 20 * 60 * 1000); // expire after 20min
      const host = req.headers['x-forwarded-host'] || req.headers['host'] || `localhost:${PORT}`;
      const proto = req.headers['x-forwarded-proto'] || (req.headers['host']?.includes('railway.app') ? 'https' : 'http');
      const imageUrl = `${proto}://${host}/img/${id}`;
      setCors(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: imageUrl }));
      return;
    }

    // ── 3. Serve stored temp image ─────────────────────────
    if (pathname.startsWith('/img/')) {
      const id = pathname.slice(5);
      const dataUrl = tempImages.get(id);
      if (!dataUrl) { res.writeHead(404); res.end('Image not found or expired'); return; }
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
      if (!match) { res.writeHead(400); res.end('Bad image data'); return; }
      const buf = Buffer.from(match[2], 'base64');
      setCors(res);
      res.writeHead(200, { 'Content-Type': match[1], 'Content-Length': buf.length });
      res.end(buf);
      return;
    }

    // ── 4. Fetch remote image → return as base64 data URL ──
    // Used to convert Replicate output URLs to base64 for display
    if (pathname === '/fetch-image' && req.method === 'POST') {
      const bodyBuf = await readBody(req);
      let imgUrl;
      try { imgUrl = JSON.parse(bodyBuf.toString()).url; } catch(e) {}
      if (!imgUrl || !imgUrl.startsWith('http')) {
        setCors(res); res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid URL' })); return;
      }
      const parsedUrl = url.parse(imgUrl);
      const r = await httpsRequest({
        hostname: parsedUrl.hostname,
        path: parsedUrl.path,
        method: 'GET',
        headers: { 'User-Agent': 'StorySpark/1.0' },
      }, null);
      const ct = r.headers['content-type'] || 'image/jpeg';
      const b64 = r.body.toString('base64');
      setCors(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ dataUrl: `data:${ct};base64,${b64}` }));
      return;
    }

    // ── 5. Health check ────────────────────────────────────
    if (pathname === '/health') {
      setCors(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, time: new Date().toISOString() })); return;
    }

    // ── 6. Serve the app ───────────────────────────────────
    const htmlFile = path.join(__dirname, 'app.html');
    if (fs.existsSync(htmlFile)) {
      const html = fs.readFileSync(htmlFile);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end('app.html not found — make sure app.html is in the same folder as server.js');
    }

  } catch(err) {
    console.error('Server error:', err);
    try {
      setCors(res);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    } catch(e) {}
  }
});

server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   StorySpark running!                ║`);
  console.log(`  ║   http://localhost:${PORT}              ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
