// StorySpark Server v2 — pre-rendered scenes + face swap pipeline
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT   = process.env.PORT || 3000;
const SCENES_DIR = path.join(__dirname, 'scenes'); // persisted pre-rendered scenes

// Ensure scenes directory exists
if (!fs.existsSync(SCENES_DIR)) fs.mkdirSync(SCENES_DIR, { recursive: true });

// Temp image store — for face photos (short-lived, 20 min)
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

    // ── 2. Upload image → get public URL ──────────────────
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
      const proto = req.headers['x-forwarded-proto'] || (host.includes('railway.app') ? 'https' : 'http');
      setCors(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: `${proto}://${host}/img/${id}` }));
      return;
    }

    // ── 3. Serve temp image ────────────────────────────────
    if (pathname.startsWith('/img/')) {
      const id = pathname.slice(5);
      const dataUrl = tempImages.get(id);
      if (!dataUrl) { res.writeHead(404); res.end('Image not found or expired'); return; }
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
      if (!match) { res.writeHead(400); res.end('Bad image data'); return; }
      const buf = Buffer.from(match[2], 'base64');
      setCors(res);
      res.writeHead(200, { 'Content-Type': match[1], 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      res.end(buf);
      return;
    }

    // ── 4. Save pre-rendered scene (admin only) ────────────
    // POST /scenes/save  { theme, index, dataUrl }
    if (pathname === '/scenes/save' && req.method === 'POST') {
      const bodyBuf = await readBody(req);
      let body;
      try { body = JSON.parse(bodyBuf.toString()); } catch(e) {}
      if (!body || !body.theme || body.index === undefined || !body.dataUrl) {
        setCors(res); res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing theme, index or dataUrl' })); return;
      }
      // Save as JPEG file: scenes/dragon/scene_00.jpg
      const themeDir = path.join(SCENES_DIR, body.theme);
      if (!fs.existsSync(themeDir)) fs.mkdirSync(themeDir, { recursive: true });
      const match = body.dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
      if (!match) {
        setCors(res); res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid dataUrl' })); return;
      }
      const ext = match[1].includes('png') ? 'png' : 'webp';
      const filename = `scene_${String(body.index).padStart(2,'0')}.${ext}`;
      const filepath = path.join(themeDir, filename);
      fs.writeFileSync(filepath, Buffer.from(match[2], 'base64'));
      console.log(`Saved scene: ${body.theme}/${filename}`);
      // Update manifest
      const manifestPath = path.join(themeDir, 'manifest.json');
      let manifest = [];
      if (fs.existsSync(manifestPath)) {
        try { manifest = JSON.parse(fs.readFileSync(manifestPath,'utf8')); } catch(e) {}
      }
      manifest[body.index] = { index: body.index, filename, title: body.title || '' };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      const host = req.headers['x-forwarded-host'] || req.headers['host'] || `localhost:${PORT}`;
      const proto = req.headers['x-forwarded-proto'] || (host.includes('railway.app') ? 'https' : 'http');
      setCors(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: `${proto}://${host}/scenes/${body.theme}/${filename}` }));
      return;
    }

    // ── 5. Get scene library status ────────────────────────
    // GET /scenes/status
    if (pathname === '/scenes/status') {
      const status = {};
      if (fs.existsSync(SCENES_DIR)) {
        const themes = fs.readdirSync(SCENES_DIR).filter(f =>
          fs.statSync(path.join(SCENES_DIR, f)).isDirectory()
        );
        for (const theme of themes) {
          const manifestPath = path.join(SCENES_DIR, theme, 'manifest.json');
          if (fs.existsSync(manifestPath)) {
            try {
              const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
              status[theme] = { count: manifest.filter(Boolean).length, scenes: manifest };
            } catch(e) { status[theme] = { count: 0 }; }
          } else {
            const files = fs.readdirSync(path.join(SCENES_DIR, theme)).filter(f => !f.endsWith('.json'));
            status[theme] = { count: files.length };
          }
        }
      }
      setCors(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    // ── 6. Get all scenes for a theme as base64 ───────────
    // GET /scenes/load/:theme
    if (pathname.startsWith('/scenes/load/')) {
      const theme = pathname.slice('/scenes/load/'.length);
      const themeDir = path.join(SCENES_DIR, theme);
      if (!fs.existsSync(themeDir)) {
        setCors(res); res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Theme not found', scenes: [] })); return;
      }
      const manifestPath = path.join(themeDir, 'manifest.json');
      let manifest = [];
      if (fs.existsSync(manifestPath)) {
        try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch(e) {}
      }
      const host = req.headers['x-forwarded-host'] || req.headers['host'] || `localhost:${PORT}`;
      const proto = req.headers['x-forwarded-proto'] || (host.includes('railway.app') ? 'https' : 'http');
      const scenes = manifest.map((m, i) => {
        if (!m) return null;
        return { index: i, title: m.title, url: `${proto}://${host}/scenes/${theme}/${m.filename}` };
      }).filter(Boolean);
      setCors(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ theme, scenes }));
      return;
    }

    // ── 7. Serve static scene images ──────────────────────
    if (pathname.startsWith('/scenes/') && !pathname.includes('/save') && !pathname.includes('/status') && !pathname.includes('/load')) {
      const filePath = path.join(__dirname, pathname);
      if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
        const ext = path.extname(filePath).toLowerCase();
        const ct = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        const buf = fs.readFileSync(filePath);
        setCors(res);
        res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' });
        res.end(buf);
      } else {
        res.writeHead(404); res.end('Scene not found');
      }
      return;
    }

    // ── 8. Fetch remote image → base64 ────────────────────
    if (pathname === '/fetch-image' && req.method === 'POST') {
      const bodyBuf = await readBody(req);
      let imgUrl;
      try { imgUrl = JSON.parse(bodyBuf.toString()).url; } catch(e) {}
      if (!imgUrl || !imgUrl.startsWith('http')) {
        setCors(res); res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid URL' })); return;
      }
      const parsedUrl = url.parse(imgUrl);
      const r = await httpsRequest({
        hostname: parsedUrl.hostname, path: parsedUrl.path, method: 'GET',
        headers: { 'User-Agent': 'StorySpark/1.0' },
      }, null);
      const ct = r.headers['content-type'] || 'image/jpeg';
      setCors(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ dataUrl: `data:${ct};base64,${r.body.toString('base64')}` }));
      return;
    }

    // ── 9. Health ──────────────────────────────────────────
    if (pathname === '/health') {
      const sceneStatus = {};
      if (fs.existsSync(SCENES_DIR)) {
        fs.readdirSync(SCENES_DIR).filter(f =>
          fs.statSync(path.join(SCENES_DIR, f)).isDirectory()
        ).forEach(theme => {
          const files = fs.readdirSync(path.join(SCENES_DIR, theme)).filter(f => !f.endsWith('.json'));
          sceneStatus[theme] = files.length;
        });
      }
      setCors(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, time: new Date().toISOString(), scenes: sceneStatus }));
      return;
    }

    // ── 10. Serve admin tool ───────────────────────────────
    if (pathname === '/admin') {
      const adminFile = path.join(__dirname, 'admin.html');
      if (fs.existsSync(adminFile)) {
        const html = fs.readFileSync(adminFile);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } else {
        res.writeHead(404); res.end('admin.html not found');
      }
      return;
    }

    // ── 11. Serve the app ──────────────────────────────────
    const htmlFile = path.join(__dirname, 'app.html');
    if (fs.existsSync(htmlFile)) {
      const html = fs.readFileSync(htmlFile);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(404); res.end('app.html not found');
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
  console.log(`  ║   StorySpark v2 running!             ║`);
  console.log(`  ║   http://localhost:${PORT}              ║`);
  console.log(`  ║   Admin: http://localhost:${PORT}/admin  ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
