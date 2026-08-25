import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Room } from './room.js';
import { Msg } from '../shared/const.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const STATIC_DIRS = ['client', 'public', 'node_modules', '.'];  // '.' exposes /shared

function resolveFile(urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' ) rel = '/index.html';
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  for (const d of STATIC_DIRS) {
    const p = path.join(ROOT, d, rel);
    if (p.startsWith(path.join(ROOT, d)) && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

const server = http.createServer((req, res) => {
  const file = resolveFile(req.url);
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream',
                       'Content-Length': stat.size,
                       // assets are rebuilt as the map pipeline is re-run, so never
                       // let a browser hold a stale model/texture/data file
                       'Cache-Control': 'no-cache, no-store, must-revalidate' });
  fs.createReadStream(file).pipe(res);
});

const rooms = new Map();
const getRoom = (id) => {
  if (!rooms.has(id)) rooms.set(id, new Room(id));
  return rooms.get(id);
};

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const room = getRoom(url.searchParams.get('room') || 'arena');
  let player = null;
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf); } catch { return; }
    if (!player) {
      if (m.t !== Msg.HELLO) return;
      player = room.join(ws, m.name);
      return;
    }
    try { room.handle(player, m); } catch (e) { console.error('handle', m.t, e.message); }
  });
  ws.on('close', () => room.leave(player));
  ws.on('error', () => room.leave(player));
});

server.listen(PORT, HOST, () => {
  console.log(`FOCS server listening on http://${HOST}:${PORT}  (ws: /ws)`);
});
