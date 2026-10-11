// ZONE — سرور آنلاین (بدون وابستگی؛ فقط Node.js 18+)
// اجرا:  node server.js   (پورت پیش‌فرض 3000 یا متغیر PORT)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = +process.env.PORT || 3000, MAXP = +process.env.MAX_PLAYERS || 16;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,23}$/;
const clients = new Map(); let nid = 1, dirty = false;

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.end('ok ' + clients.size); return; }
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => {
    if (e) { res.writeHead(404); res.end('index.html not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(d);
  });
});

function frame(c, op, payload) {
  const n = payload.length; let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); }
  if (!c.socket.destroyed) c.socket.write(Buffer.concat([h, payload]));
}
const send = (c, o) => frame(c, 1, Buffer.from(JSON.stringify(o)));
function drop(c) { if (clients.delete(c.id)) { dirty = true; console.log('- ' + c.id + ' (' + clients.size + ')'); } c.socket.destroy(); }

function clean(v, d = 0) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') return v.slice(0, 40);
  if (v && typeof v === 'object' && !Array.isArray(v) && d < 1) {
    const o = {}; let n = 0;
    for (const k in v) { if (n++ > 20) break; if (!KEY_RE.test(k)) continue; const x = clean(v[k], d + 1); if (x !== undefined) o[k] = x; }
    return o;
  }
  return undefined;
}
function onMsg(c, txt) {
  const now = Date.now(); if (now - c.win > 1000) { c.win = now; c.cnt = 0; } if (++c.cnt > 80) return;
  let m; try { m = JSON.parse(txt); } catch (e) { return; }
  if (m && m.t === 'p' && m.p && typeof m.p === 'object') {
    for (const k in m.p) {
      if (!KEY_RE.test(k)) continue;
      if (m.p[k] === null) delete c.p[k]; else { const x = clean(m.p[k]); if (x !== undefined) c.p[k] = x; }
    }
    if (JSON.stringify(c.p).length > 4096) { drop(c); return; }
    dirty = true;
  }
}
function parse(c) {
  for (;;) {
    const b = c.buf; if (b.length < 2) return;
    const op = b[0] & 15, fin = b[0] & 128, masked = b[1] & 128; let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; } else if (len === 127) { drop(c); return; }
    if (!masked) { drop(c); return; }
    if (b.length < off + 4 + len) return;
    const mask = b.subarray(off, off + 4), data = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
    c.buf = b.subarray(off + 4 + len);
    if (op === 8) { drop(c); return; }
    if (op === 9) { frame(c, 10, data); continue; }
    if (op === 10) { c.alive = true; continue; }
    if (op === 1 && fin) onMsg(c, data.toString('utf8'));
  }
}
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || clients.size >= MAXP) { socket.destroy(); return; }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + GUID).digest('base64') + '\r\n\r\n');
  socket.setNoDelay(true);
  const id = 'p' + (nid++).toString(36) + crypto.randomBytes(2).toString('hex');
  const c = { socket, id, p: {}, buf: Buffer.alloc(0), alive: true, cnt: 0, win: Date.now() };
  clients.set(id, c); console.log('+ ' + id + ' (' + clients.size + ')');
  send(c, { t: 'hello', id }); dirty = true;
  socket.on('data', d => { c.buf = Buffer.concat([c.buf, d]); if (c.buf.length > 16384) { drop(c); return; } parse(c); });
  socket.on('close', () => drop(c)); socket.on('error', () => drop(c));
});
setInterval(() => {                                   // ارسال وضعیت همه‌ی بازیکن‌ها، ۲۰ بار در ثانیه
  if (!dirty) return; dirty = false;
  const msg = Buffer.from(JSON.stringify({ t: 's', list: [...clients.values()].map(c => [c.id, c.p]) }));
  for (const c of clients.values()) frame(c, 1, msg);
}, 50);
setInterval(() => { for (const c of [...clients.values()]) { if (!c.alive) { drop(c); continue; } c.alive = false; frame(c, 9, Buffer.alloc(0)); } }, 20000);
server.listen(PORT, () => console.log('ZONE server on http://localhost:' + PORT));
