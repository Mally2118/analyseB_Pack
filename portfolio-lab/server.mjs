import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { loadMarketData, ProviderError } from './data-providers.mjs';
const base = resolve(import.meta.dirname, 'dist');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
let activeImports = 0;
createServer(async (req,res) => {
  try {
    const url = new URL(req.url,'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/api/market-data') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'GET') {res.writeHead(405, {'Allow':'GET'});res.end(JSON.stringify({error:'Используйте GET для загрузки статистики.'}));return;}
      if (activeImports >= 3) {res.writeHead(429);res.end(JSON.stringify({error:'Загрузка статистики уже выполняется. Попробуйте через несколько секунд.'}));return;}
      activeImports++;
      try {
        const data = await loadMarketData(url.searchParams.get('from'),url.searchParams.get('to'));
        res.writeHead(200);res.end(JSON.stringify(data));
      } catch(error) {
        res.writeHead(error instanceof ProviderError ? error.status : 502);
        res.end(JSON.stringify({error:error instanceof ProviderError ? error.message : 'Источник статистики вернул неизвестный ответ. Попробуйте позже или загрузите Excel.',code:error.code || 'SOURCE_UNAVAILABLE',latestAvailable:error.latestAvailable}));
      } finally {activeImports--;}
      return;
    }
    if (pathname.startsWith('/api/')) {res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'Неизвестный API.'}));return;}
    const file = resolve(base, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(base + sep)) {res.writeHead(403);res.end();return;}
    const content=await readFile(file);
    res.writeHead(200, {'Content-Type': types[extname(file)] || 'application/octet-stream'});
    res.end(content);
  } catch {if (!res.headersSent) res.writeHead(404);res.end('Not found');}
}).listen(Number(process.env.PORT || 4173),'127.0.0.1',function(){console.log(`Portfolio Lab: http://127.0.0.1:${this.address().port}`)});
