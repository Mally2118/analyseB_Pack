import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const base = resolve(import.meta.dirname, 'dist');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
createServer(async (req,res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file = resolve(base, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(base + sep)) {res.writeHead(403);res.end();return;}
    const content=await readFile(file);
    res.writeHead(200, {'Content-Type': types[extname(file)] || 'application/octet-stream'});
    res.end(content);
  } catch {if (!res.headersSent) res.writeHead(404);res.end('Not found');}
}).listen(4173,'127.0.0.1',()=>console.log('Portfolio Lab: http://127.0.0.1:4173'));
