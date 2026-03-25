// StorySpark Server
// Pure Node.js — no npm dependencies needed
// Proxies Replicate API calls (solves CORS), serves the frontend

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = process.env.PORT || 3000;

// ── Helpers ──────────────────────────────────────────────

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Route handlers ───────────────────────────────────────

async function handleReplicate(req, res, pathname) {
  // Strip /api/replicate prefix and forward to Replicate
  const replicatePath = pathname.replace('/api/replicate', '');
  const body = await readBody(req);

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

  if (body.length > 0) {
    options.headers['Content-Length'] = body.length;
  }

  try {
    const result = await httpsRequest(options, body.length > 0 ? body : null);
    setCORS(res);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(result.body);
  } catch(e) {
    setCORS(res);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy error', detail: e.message }));
  }
}

async function handleImageProxy(req, res) {
  // Fetch an image URL and return it as base64 data URL
  // Avoids CORS issues with Replicate CDN
  const body = await readBody(req);
  let imageUrl;
  try {
    imageUrl = JSON.parse(body.toString()).url;
  } catch(e) {
    res.writeHead(400); res.end('Bad request'); return;
  }

  if (!imageUrl || (!imageUrl.startsWith('https://') && !imageUrl.startsWith('http://'))) {
    setCORS(res);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid URL' }));
    return;
  }

  const parsed = url.parse(imageUrl);
  const options = {
    hostname: parsed.hostname,
    path: parsed.path,
    method: 'GET',
    headers: { 'User-Agent': 'StorySpark/1.0' },
  };

  try {
    const result = await httpsRequest(options, null);
    const contentType = result.headers['content-type'] || 'image/jpeg';
    const base64 = result.body.toString('base64');
    setCORS(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ dataUrl: `data:${contentType};base64,${base64}` }));
  } catch(e) {
    setCORS(res);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Image fetch failed', detail: e.message }));
  }
}

function serveHTML(res) {
  const htmlPath = path.join(__dirname, 'app.html');
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else {
    res.writeHead(404);
    res.end('app.html not found — make sure app.html is in the same folder as server.js');
  }
}

// ── Main server ──────────────────────────────────────────

// Temporary image store — images expire after 10 minutes
const tempImages = new Map();
let imageCounter = 0;

async function handleImageUpload(req, res) {
  const body = await readBody(req);
  let dataUrl;
  try {
    dataUrl = JSON.parse(body.toString()).dataUrl;
  } catch(e) {
    setCORS(res); res.writeHead(400); res.end('Bad request'); return;
  }

  // Store with a unique ID
  const id = `img_${Date.now()}_${++imageCounter}`;
  tempImages.set(id, dataUrl);

  // Auto-expire after 10 minutes
  setTimeout(() => tempImages.delete(id), 10 * 60 * 1000);

  // Return the public URL to this image
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || `localhost:${PORT}`;
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const imageUrl = `${protocol}://${host}/api/img/${id}`;

  setCORS(res);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ url: imageUrl }));
}

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    setCORS(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // Route: Replicate API proxy
  if (pathname.startsWith('/api/replicate/')) {
    await handleReplicate(req, res, pathname);
    return;
  }

  // Route: Serve temporarily stored images (so Replicate can fetch them)
  if (pathname.startsWith('/api/img/') && req.method === 'GET') {
    const id = pathname.replace('/api/img/', '');
    const dataUrl = tempImages.get(id);
    if (!dataUrl) {
      res.writeHead(404); res.end('Image not found or expired'); return;
    }
    // Parse the base64 data URL
    const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) { res.writeHead(400); res.end('Bad image data'); return; }
    const [, mimeType, base64Data] = matches;
    const buffer = Buffer.from(base64Data, 'base64');
    setCORS(res);
    res.writeHead(200, { 'Content-Type': mimeType, 'Content-Length': buffer.length });
    res.end(buffer);
    return;
  }

  // Route: Image fetch proxy (converts URL → base64 data URL)
  if (pathname === '/api/image' && req.method === 'POST') {
    await handleImageProxy(req, res);
    return;
  }

  // Route: Temp image host — stores base64 image, returns public URL for Replicate
  // Replicate needs a real URL, can't accept base64 directly
  if (pathname === '/api/upload' && req.method === 'POST') {
    await handleImageUpload(req, res);
    return;
  }

  // Route: Health check
  if (pathname === '/health') {
    setCORS(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
    return;
  }

  // Route: Serve frontend for all other routes
  serveHTML(res);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔════════════════════════════════════════╗');
  console.log('  ║       StorySpark is running!           ║');
  console.log('  ╠════════════════════════════════════════╣');
  console.log(`  ║  Local:  http://localhost:${PORT}         ║`);
  console.log('  ║  Press Ctrl+C to stop                  ║');
  console.log('  ╚════════════════════════════════════════╝');
  console.log('');
});
