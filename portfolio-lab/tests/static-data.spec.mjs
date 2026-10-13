import {test,expect} from '@playwright/test';
import {officialSnapshot} from './fixtures.mjs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {preparePages} from '../prepare-pages.mjs';
const base='https://mally2118.github.io/analyseB_Pack/';
test('GitHub Pages automatically loads genuine statistics and selects source periods without a backend',async({page})=>{
  const api=[],snapshotRequests=[];
  page.on('request',r=>{if(r.url().includes('/api/'))api.push(r.url());if(r.url().endsWith('/data/market-data.json'))snapshotRequests.push(r.url());});
  await page.route(base+'**',async route=>{
    const suffix=route.request().url().slice(base.length);
    if(suffix==='data/market-data.json')return route.fulfill({json:officialSnapshot()});
    const response=await route.fetch({url:'http://127.0.0.1:4173/'+suffix});await route.fulfill({response});
  });
  await page.goto(base);await expect(page.locator('#equity-chart svg')).toBeVisible();
  await page.click('#tab-data');await expect(page.locator('#online-provenance')).toContainText('Подготовленная официальная статистика');
  await page.fill('#online-from','2020-01');await page.fill('#online-to','2025-12');await page.click('#online-load-button');
  await expect(page.locator('#online-load-button')).toBeEnabled();await expect(page.locator('#data-info')).toContainText('2020-01-31');
  await expect(page.locator('#indicators-table tbody tr')).toHaveCount(9);expect(api).toEqual([]);expect(snapshotRequests).toHaveLength(2);
});

test('published assets bypass stale root scripts and styles, including nested imports and repository-relative official data',async({page},testInfo)=>{
  const build=await preparePages({output:testInfo.outputPath('pages')});
  const errors=[],staleRequests=[],assets=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route(base+'**',async route=>{
    const path=new URL(route.request().url()).pathname.slice(new URL(base).pathname.length)||'index.html';
    if(['app.js','engine.js','style.css'].includes(path)){
      staleRequests.push(path);
      return route.fulfill({contentType:path.endsWith('.css')?'text/css':'text/javascript',body:path.endsWith('.css')?'body { display: none; }':"throw Error('Stale script from before deployment');"});
    }
    if(path.startsWith(build.assets))assets.push(path);
    const types={js:'text/javascript',css:'text/css',json:'application/json',html:'text/html',svg:'image/svg+xml',woff2:'font/woff2'};
    try{await route.fulfill({body:await readFile(join(build.output,path)),contentType:types[path.split('.').at(-1)]||'application/octet-stream'});}
    catch{await route.fulfill({status:404,body:'File missing from published artifact'});}
  });
  await page.goto(base);await expect(page.locator('#equity-chart svg')).toBeVisible();
  await expect(page.locator('#indicators-table tbody tr')).toHaveCount(9);
  expect(staleRequests).toEqual([]);expect(errors).toEqual([]);
  for(const file of ['app.js','engine.js','macro.js','style.css','fonts.css'])expect(assets).toContain(build.assets+file);
  await page.click('#tab-graphs');await expect(page.locator('#inflation-chart svg')).toBeVisible();await expect(page.locator('#m2-chart svg')).toBeVisible();
});
