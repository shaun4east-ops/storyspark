// StorySpark Server v2 — pre-rendered scene library + face swap pipeline
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = process.env.PORT || 3000;

// Temp image store — holds uploaded photos so Replicate can fetch them via URL
const tempImages = new Map();
let imgCounter = 0;

// Pre-rendered scene library — stored in /scenes/{theme}/{scene_index}.webp
// Admin generates these once; customers reuse them every story
const SCENES_DIR = path.join(__dirname, 'scenes');
if (!fs.existsSync(SCENES_DIR)) fs.mkdirSync(SCENES_DIR, { recursive: true });

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
      setTimeout(() => tempImages.delete(id), 20 * 60 * 1000);
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
      res.writeHead(200, { 'Content-Type': match[1], 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=1200' });
      res.end(buf);
      return;
    }

    // ── 4. Fetch remote image → return as base64 data URL ──
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

    // ── 5. Save pre-rendered scene (admin only) ────────────
    // POST /scenes/save  { theme, index, dataUrl }
    // Saves a pre-rendered scene image to disk permanently
    if (pathname === '/scenes/save' && req.method === 'POST') {
      const bodyBuf = await readBody(req);
      let body;
      try { body = JSON.parse(bodyBuf.toString()); } catch(e) {}
      const { theme, index, dataUrl, adminKey } = body || {};

      // Simple admin key check — set ADMIN_KEY env var on Railway
      const expectedKey = process.env.ADMIN_KEY || 'storyspark-admin-2026';
      if (adminKey !== expectedKey) {
        setCors(res); res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }
      if (!theme || index === undefined || !dataUrl) {
        setCors(res); res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing theme, index, or dataUrl' })); return;
      }

      // Save to disk: /scenes/{theme}/{index}.webp
      const themeDir = path.join(SCENES_DIR, theme);
      if (!fs.existsSync(themeDir)) fs.mkdirSync(themeDir, { recursive: true });

      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
      if (!match) {
        setCors(res); res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid dataUrl format' })); return;
      }

      const ext = match[1].includes('webp') ? 'webp' : match[1].includes('png') ? 'png' : 'jpg';
      const filePath = path.join(themeDir, `${index}.${ext}`);
      fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));

      console.log(`✅ Saved scene: ${theme}/${index}.${ext}`);
      setCors(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: `${theme}/${index}.${ext}` }));
      return;
    }

    // ── 6. Get scene library status (admin) ───────────────
    // GET /scenes/status
    if (pathname === '/scenes/status') {
      const status = {};
      if (fs.existsSync(SCENES_DIR)) {
        for (const theme of fs.readdirSync(SCENES_DIR)) {
          const themeDir = path.join(SCENES_DIR, theme);
          if (fs.statSync(themeDir).isDirectory()) {
            status[theme] = fs.readdirSync(themeDir).length;
          }
        }
      }
      setCors(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ scenes: status }));
      return;
    }

    // ── 7. Serve pre-rendered scene as URL ────────────────
    // GET /scenes/{theme}/{index}
    // Returns the pre-rendered scene image — used by face swap as target_image
    if (pathname.startsWith('/scenes/') && req.method === 'GET') {
      const parts = pathname.split('/').filter(Boolean); // ['scenes', 'dragon', '0']
      if (parts.length === 3) {
        const [, theme, indexStr] = parts;
        const themeDir = path.join(SCENES_DIR, theme);
        // Find the file with any extension
        let filePath = null;
        for (const ext of ['webp', 'jpg', 'png']) {
          const fp = path.join(themeDir, `${indexStr}.${ext}`);
          if (fs.existsSync(fp)) { filePath = fp; break; }
        }
        if (filePath) {
          const buf = fs.readFileSync(filePath);
          const ext = path.extname(filePath).slice(1);
          const ct = ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : 'image/jpeg';
          setCors(res);
          res.writeHead(200, {
            'Content-Type': ct,
            'Content-Length': buf.length,
            'Cache-Control': 'public, max-age=86400' // cache for 24h — scenes never change
          });
          res.end(buf);
          return;
        }
      }
      setCors(res); res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Scene not found' }));
      return;
    }

    // ── 8. Health check ────────────────────────────────────
    if (pathname === '/health') {
      setCors(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, time: new Date().toISOString() })); return;
    }

    // ── 9. Serve the app ───────────────────────────────────
    // /admin → admin.html, everything else → app.html
    const isAdmin = pathname === '/admin' || pathname === '/admin.html';
    const htmlFile = path.join(__dirname, isAdmin ? 'admin.html' : 'app.html');
    if (fs.existsSync(htmlFile)) {
      const html = fs.readFileSync(htmlFile);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end(`${isAdmin ? 'admin.html' : 'app.html'} not found`);
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
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║   StorySpark v2 running!                 ║`);
  console.log(`  ║   http://localhost:${PORT}                ║`);
  console.log(`  ║   Admin: http://localhost:${PORT}/admin   ║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
});
