import {test,expect} from '@playwright/test';
import {officialSnapshot} from './fixtures.mjs';
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
