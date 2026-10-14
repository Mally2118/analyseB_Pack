import {test,expect} from '@playwright/test';
import XLSX from 'xlsx';
import {readFile} from 'node:fs/promises';
import {officialSnapshot} from './fixtures.mjs';
import {selectSnapshotPeriod} from '../dist/market-data-client.js';
import {estimate,createOptimizer,metrics} from '../dist/engine.js';
const snapshot=officialSnapshot();
const initial=selectSnapshotPeriod(snapshot,snapshot.rows.slice(-60)[0].date.slice(0,7),snapshot.period.to);
const model=estimate(initial),rf=1.08/(1+model.inflation)-1;
const solution=createOptimizer(model).solve('markowitz',{lambda:3,rf});
const chart=(page,id)=>page.evaluate(id=>echarts.getInstanceByDom(document.getElementById(id)).getOption(),id);
async function tab(page,name){await page.locator('#tab-'+name).click();await expect(page.locator('#panel-'+name)).toBeVisible();}
async function ready(page){await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();}
async function calculate(page){await page.click('#calculate-button');await expect(page.locator('#calculate-button')).toBeEnabled();}
async function download(page,testInfo,selector,name){const waiting=page.waitForEvent('download');await page.locator(selector).click();const d=await waiting;const file=testInfo.outputPath(name);await d.saveAs(file);return {file,bytes:await readFile(file)};}

// These expectations are computed from the actual official snapshot, not fixed demo weights.
test('startup uses published source observations and excludes M2 from every portfolio criterion',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const exampleRequests=[];page.on('request',r=>{if(r.url().includes('/examples/'))exampleRequests.push(r.url());});
  await ready(page);
  await expect(page.locator('#data-badge')).toHaveText('Официальные данные');
  await expect(page.locator('#mode')).toHaveValue('markowitz');
  await expect(page.locator('#indicators-table tbody tr')).toHaveCount(model.names.length);
  await expect(page.locator('#indicators-table tbody')).toContainText('Корпоративные облигации / RUCBTRNS');
  expect(await page.locator('#indicators-table tbody').textContent()).not.toMatch(/М2/);
  expect((await chart(page,'equity-chart')).series[0].data).toEqual(metrics(model,solution.weights,rf).wealth.map(v=>(v-1)*100));
  for(const mode of ['markowitz','sharpe','risk','return']){
    await page.selectOption('#mode',mode);await calculate(page);
    await expect(page.locator('#message')).not.toHaveClass(/error/);
    const weights=(await chart(page,'weights-chart')).series[0].data;
    expect(weights.every(p=>!p.name.includes('М2'))).toBeTruthy();
    expect(weights.reduce((s,p)=>s+p.value,0)).toBeCloseTo(100,6);
  }
  expect(exampleRequests).toEqual([]);expect(errors).toEqual([]);
});

test('inflation and M2 charts match source ratios and export SVG, with unavailable history left empty',async({page},testInfo)=>{
  await ready(page);await tab(page,'graphs');
  let option=await chart(page,'inflation-chart');
  expect(option.series[0].data.slice(0,12)).toEqual(Array(12).fill(null));
  expect(option.series[0].data[12]).toBeCloseTo((initial.rows[12].cpi/initial.rows[0].cpi-1)*100,8);
  await page.selectOption('#inflation-view','monthly');option=await chart(page,'inflation-chart');
  expect(option.series[0].data[0]).toBeNull();expect(option.series[0].data[1]).toBeCloseTo((initial.rows[1].cpi/initial.rows[0].cpi-1)*100,8);
  await page.selectOption('#inflation-view','total');option=await chart(page,'inflation-chart');
  expect(option.series[0].data).toEqual(initial.rows.map(row=>(row.cpi/initial.rows[0].cpi-1)*100));
  expect((await chart(page,'m2-chart')).series[0].data).toEqual(initial.rows.map(row=>row.values[0]));
  const svg=await download(page,testInfo,'[data-download="inflation-chart"]','inflation.svg');expect(svg.bytes.toString()).toContain('<svg');
  await page.screenshot({path:testInfo.outputPath('official-macro-desktop.png'),fullPage:true});
});

test('comparison, removal, common period, saved sets and Excel keep ten investable rows and source macro levels',async({page},testInfo)=>{
  await ready(page);await tab(page,'comparison');await page.click('#compare-all-button');
  await expect(page.locator('#message')).not.toHaveClass(/error/);
  await expect(page.locator('#comparison-table tbody tr')).toHaveCount(5);
  const start=initial.rows[12].date,end=initial.rows.at(-1).date;
  await page.fill('#comparison-from',start);await page.fill('#comparison-to',end);await page.click('#comparison-period-apply');
  await expect(page.locator('#message')).not.toHaveClass(/error/);
  const downloaded=await download(page,testInfo,'#export-button','official-comparison.xlsx');const book=XLSX.read(downloaded.bytes,{type:'buffer'});
  const weights=XLSX.utils.sheet_to_json(book.Sheets['Веса'],{header:1});expect(weights).toHaveLength(model.names.length+1);
  expect(weights.at(-1)[0]).toContain('RUCBTRNS');
  expect(weights.slice(1).some(row=>/М2/.test(row[0]))).toBeFalsy();
  for(let i=1;i<weights[0].length;i++)expect(weights.slice(1).reduce((s,row)=>s+row[i],0)).toBeCloseTo(1,8);
  expect(book.SheetNames).toContain('Инфляция и М2');
  const source=XLSX.utils.sheet_to_json(book.Sheets['Исходные данные'],{header:1});expect(source[0][2]).toContain('М2');
  expect(source[0].at(-1)).toContain('RUCBTRNS');
  const capital=XLSX.utils.sheet_to_json(book.Sheets['Реальный капитал'],{header:1});expect(capital[1][0]).toBe(start);expect(capital[1].slice(1)).toEqual(Array(5).fill(1e6));
  const firstId=await page.locator('[data-remove]').first().getAttribute('data-remove');await page.locator('[data-remove="'+firstId+'"]').click();
  await expect(page.locator('#comparison-table tbody tr')).toHaveCount(4);
  await page.locator('.comparison-library').evaluate(el=>el.open=true);await page.fill('#comparison-set-name','Официальные данные');await page.click('#comparison-set-save');
  const set=await page.locator('#comparison-set-select').inputValue();await page.reload();await expect(page.locator('#comparison-table tbody tr')).toHaveCount(1);
  await page.locator('.comparison-library').evaluate(el=>el.open=true);await page.selectOption('#comparison-set-select',set);await page.click('#comparison-set-open');
  await expect(page.locator('#message')).not.toHaveClass(/error/);await expect(page.locator('#comparison-table tbody tr')).toHaveCount(4);
  await expect(page.locator('#comparison-from')).toHaveValue(start);
});

test('holdout weights and equal-weight benchmark exclude M2 in charts, tables and Excel',async({page},testInfo)=>{
  await ready(page);await tab(page,'backtest');await page.click('#backtest-run-button');
  await expect(page.locator('#backtest-results')).toBeVisible();
  const weights=await chart(page,'backtest-weights-chart');const categories=weights.xAxis[0].data||weights.yAxis[0].data;
  expect(categories).toHaveLength(model.names.length);expect(categories.some(name=>name.includes('М2'))).toBeFalsy();
  expect(weights.series.at(-1).data).toEqual(Array(model.names.length).fill(100/model.names.length));
  const output=await download(page,testInfo,'#backtest-export-button','official-validation.xlsx');const book=XLSX.read(output.bytes,{type:'buffer'});
  expect(XLSX.utils.sheet_to_json(book.Sheets['Веса'],{header:1})).toHaveLength(model.names.length+1);
  expect(XLSX.utils.sheet_to_json(book.Sheets['Веса'],{header:1}).slice(1).some(row=>row[0].includes('М2'))).toBeFalsy();
});

test('language, theme, guide and keyboard tabs work on mobile without losing the calculated portfolio',async({page},testInfo)=>{
  await ready(page);const before=(await chart(page,'weights-chart')).series[0].data.map(p=>p.value);
  await page.click('#language-button');await page.click('#theme-button');await page.setViewportSize({width:390,height:844});
  for(const name of ['graphs','data','comparison','backtest','help','portfolio']){
    await tab(page,name);expect(await page.locator('#panel-'+name).textContent()).not.toMatch(/[А-Яа-яЁё]/);
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  }
  expect((await chart(page,'weights-chart')).series[0].data.map(p=>p.value)).toEqual(before);
  await page.locator('#tab-portfolio').focus();await page.keyboard.press('End');await expect(page.locator('#tab-help')).toBeFocused();
  await page.locator('#panel-help details').nth(1).locator('summary').click();await expect(page.locator('#panel-help details').nth(1)).toHaveAttribute('open','');
  await tab(page,'graphs');await page.screenshot({path:testInfo.outputPath('official-macro-mobile-dark.png'),fullPage:true});
});

test('an unavailable source at startup leaves calculations disabled and never substitutes generated data',async({page})=>{
  await page.route('**/data/market-data.json',route=>route.fulfill({status:503,body:'unavailable'}));
  await page.goto('/');await expect(page.locator('#data-status')).toHaveText('Нет данных');
  await expect(page.locator('#calculate-button')).toBeDisabled();await expect(page.locator('#save-button')).toBeDisabled();
  await expect(page.locator('#expected-income')).toHaveText('—');await expect(page.locator('#equity-chart svg')).toHaveCount(0);
  await tab(page,'data');await expect(page.locator('#online-status')).toHaveClass(/error/);await expect(page.locator('#online-load-button')).toBeEnabled();
});

test('new source loads reset stale comparisons, and source failures preserve the last successful calculation',async({page})=>{
  await ready(page);await tab(page,'data');
  const from='2020-01',to='2025-12';await page.fill('#online-from',from);await page.fill('#online-to',to);
  await page.route('**/api/market-data?**',route=>route.fulfill({json:selectSnapshotPeriod(snapshot,from,to)}));
  await page.click('#online-load-button');await expect(page.locator('#online-status')).not.toHaveClass(/error/);
  await expect(page.locator('#data-info')).toContainText('2020-01-31');
  const before=await page.locator('#expected-income').textContent();
  await page.unroute('**/api/market-data?**');await page.route('**/api/market-data?**',route=>route.fulfill({status:502,json:{error:'Источник недоступен'}}));
  await page.click('#online-load-button');await expect(page.locator('#online-status')).toHaveClass(/error/);
  await expect(page.locator('#expected-income')).toHaveText(before);await expect(page.locator('#calculate-button')).toBeEnabled();
});

test('a short published period keeps holdout disabled after recalculating, while macro shortcuts scroll to the source charts',async({page})=>{
  await ready(page);await tab(page,'data');const from='2025-08',to='2026-08';
  await page.route('**/api/market-data?**',route=>route.fulfill({json:selectSnapshotPeriod(snapshot,from,to)}));
  await page.fill('#online-from',from);await page.fill('#online-to',to);await page.click('#online-load-button');
  await expect(page.locator('#online-load-button')).toBeEnabled();await expect(page.locator('#data-info')).toContainText('13');
  await expect(page.locator('#backtest-run-button')).toBeDisabled();await tab(page,'portfolio');await calculate(page);await expect(page.locator('#backtest-run-button')).toBeDisabled();
  await tab(page,'data');await page.locator('#panel-data [data-scroll-target="macro-summary"]').click();await expect(page.locator('#panel-graphs')).toBeVisible();
  await expect.poll(()=>page.locator('#macro-summary').evaluate(el=>el.getBoundingClientRect().top>=0&&el.getBoundingClientRect().bottom<=innerHeight)).toBeTruthy();
});

test('English Excel reports translate asset names and keep M2 only in source and macro sheets',async({page},testInfo)=>{
  await ready(page);await page.click('#language-button');await tab(page,'comparison');
  const downloaded=await download(page,testInfo,'#export-button','english-official.xlsx'),book=XLSX.read(downloaded.bytes,{type:'buffer'});
  const weights=XLSX.utils.sheet_to_json(book.Sheets.Weights,{header:1});expect(weights).toHaveLength(model.names.length+1);
  expect(JSON.stringify(weights)).not.toMatch(/[А-Яа-яЁё]/);expect(JSON.stringify(weights)).not.toContain('M2');
  expect(book.SheetNames).toContain('Inflation and M2');expect(book.SheetNames).toContain('Sources');
  const source=XLSX.utils.sheet_to_json(book.Sheets['Source data'],{header:1});expect(source[0][2]).toContain('M2');expect(JSON.stringify(source[0])).not.toMatch(/[А-Яа-яЁё]/);
});

test('short mode, bounds, OAS and graph exclusions preserve saved portfolios and signed Excel weights',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await ready(page);
  await page.selectOption('#position-mode','short');await expect(page.locator('#min-weight')).toHaveValue('-30');await page.fill('#max-weight','50');await page.selectOption('#covariance-method','oas');await calculate(page);
  await expect(page.locator('#covariance-summary')).toContainText('OAS');const original=(await chart(page,'weights-chart')).series[0].data.map(item=>item.value);expect(original.some(w=>w<0)).toBeTruthy();expect(original.every(w=>w>=-30-1e-6&&w<=50+1e-6)).toBeTruthy();expect(original.reduce((a,b)=>a+b,0)).toBeCloseTo(100,6);
  await page.click('#save-button');await tab(page,'graphs');await page.locator('[data-asset="0"]').uncheck();await expect(page.locator('#asset-selection-status')).toContainText('пересчитан');expect((await chart(page,'report-weights-chart')).series[0].data[0].value).toBe(0);
  await page.selectOption('#report-portfolio','p1');expect((await chart(page,'report-weights-chart')).series[0].data.map(item=>item.value)).toEqual(original);
  await tab(page,'comparison');const {bytes}=await download(page,testInfo,'#export-button','signed.xlsx'),book=XLSX.read(bytes,{type:'buffer'}),weights=XLSX.utils.sheet_to_json(book.Sheets['Веса'],{header:1});expect(weights.some(row=>row.slice(1).some(v=>v<0))).toBeTruthy();expect(weights[1][1]).toBe(0);expect(weights[1][2]).toBeCloseTo(original[0]/100,8);
  expect(errors).toEqual([]);
});

test('minimum shares and maximum caps apply to every asset and impossible exclusions roll back',async({page})=>{
  await ready(page);await page.fill('#min-weight','5');await page.fill('#max-weight','20');await calculate(page);
  const weights=await page.locator('#indicators-table tbody tr td:last-child strong').allTextContents();expect(weights).toHaveLength(model.names.length);
  await tab(page,'graphs');for(const index of [0,1,2,3,4])await page.locator(`[data-asset="${index}"]`).uncheck();await page.locator('[data-asset="5"]').click();await expect(page.locator('[data-asset="5"]')).toBeChecked();await expect(page.locator('#asset-selection-status')).toContainText('несовместимы');await page.click('#include-all-assets');await expect(page.locator('#asset-toggles input:checked')).toHaveCount(model.names.length);
});

test('rolling backtest uses dated moving windows and exports all weights and test observations',async({page},testInfo)=>{
  await ready(page);await page.selectOption('#position-mode','short');await page.fill('#max-weight','50');await page.selectOption('#covariance-method','oas');await calculate(page);await tab(page,'graphs');await page.locator('[data-asset="1"]').uncheck();await tab(page,'backtest');await page.selectOption('#backtest-kind','rolling');await expect(page.locator('#holdout-field')).toBeHidden();await page.fill('#rolling-window','24');await page.fill('#rolling-step','5');await page.click('#backtest-run-button');await expect(page.locator('#backtest-results')).toBeVisible();await expect(page.locator('#rolling-ledger')).toBeVisible();
  const curve=await chart(page,'backtest-return-chart');expect(curve.xAxis[0].data).toHaveLength(36);expect(curve.series.every(s=>s.data.length===36)).toBeTruthy();
  const {bytes}=await download(page,testInfo,'#backtest-export-button','rolling.xlsx'),book=XLSX.read(bytes,{type:'buffer'});const folds=XLSX.utils.sheet_to_json(book.Sheets['Окна и веса'],{header:1});expect(folds.length).toBeGreaterThan(7);for(const row of folds.slice(1)){expect(row[2]<row[3]).toBeTruthy();expect(row[8]).toBe(0);expect(row.slice(7).reduce((a,b)=>a+b,0)).toBeCloseTo(1,7);}expect(XLSX.utils.sheet_to_json(book.Sheets['Проверочный капитал'],{header:1})).toHaveLength(37);
  await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:testInfo.outputPath('rolling-mobile.png'),fullPage:true});
});

test('short controls default to 150% gross and 25% short, respect both budgets and restore saved settings',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await ready(page);
  await expect(page.locator('#short-exposure-fields')).toBeHidden();await expect(page.locator('#gross-limit')).toBeDisabled();
  await page.selectOption('#position-mode','short');await expect(page.locator('#gross-limit')).toHaveValue('150');await expect(page.locator('#short-limit')).toHaveValue('25');await expect(page.locator('#min-weight-label')).toHaveText('Минимальный вес одного актива, %');await expect(page.locator('#min-weight')).toHaveValue('-30');await page.selectOption('#covariance-method','oas');
  for(const mode of ['markowitz','sharpe','risk','return']) {
    await page.selectOption('#mode',mode);await calculate(page);await expect(page.locator('#message')).not.toHaveClass(/error/);
    const option=await chart(page,'weights-chart'),weights=option.series[0].data.map(p=>p.value/100),short=weights.reduce((s,w)=>s+Math.max(0,-w),0),gross=weights.reduce((s,w)=>s+Math.abs(w),0);
    expect(short).toBeLessThanOrEqual(.25+1e-7);expect(gross).toBeLessThanOrEqual(1.5+1e-7);expect(weights.reduce((a,b)=>a+b,0)).toBeCloseTo(1,7);expect(option.series[0].markLine.data[0].xAxis).toBe(0);
    await expect(page.locator('#net-exposure')).toContainText('100,00');await expect(page.locator('#exposure-summary')).toContainText('Gross exposure');
  }
  await page.selectOption('#mode','markowitz');await page.fill('#gross-limit','120');await page.fill('#short-limit','7');await calculate(page);await page.click('#save-button');await tab(page,'comparison');
  await page.locator('.comparison-library').evaluate(el=>el.open=true);await page.fill('#comparison-set-name','Short limits');await page.click('#comparison-set-save');const set=await page.locator('#comparison-set-select').inputValue();await page.reload();await page.locator('.comparison-library').evaluate(el=>el.open=true);await page.selectOption('#comparison-set-select',set);await page.click('#comparison-set-open');await expect(page.locator('#message')).not.toHaveClass(/error/);await tab(page,'portfolio');await expect(page.locator('#gross-limit')).toHaveValue('120');await expect(page.locator('#short-limit')).toHaveValue('7');
  await page.locator('.weights-panel').screenshot({path:testInfo.outputPath('short-weights-desktop.png')});await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.locator('.weights-panel').screenshot({path:testInfo.outputPath('short-weights-mobile.png')});await page.locator('.control-panel').screenshot({path:testInfo.outputPath('short-controls-mobile.png')});
  await tab(page,'comparison');const {bytes}=await download(page,testInfo,'#export-button','budget.xlsx'),book=XLSX.read(bytes,{type:'buffer'}),exposures=XLSX.utils.sheet_to_json(book.Sheets['Экспозиции'],{header:1});for(const row of exposures.slice(1)){expect(row[2]).toBeLessThanOrEqual(.07+1e-7);expect(row[4]).toBeLessThanOrEqual(1.2+1e-7);expect(row[3]).toBeCloseTo(1,7);expect(row[5]).toBe(120);expect(row[6]).toBeCloseTo(7,8);}
  expect(errors).toEqual([]);
});

test('gross=100 and short=0 show explanations and forbid shorts; long-only keeps its original result',async({page})=>{
  await ready(page);const original=(await chart(page,'equity-chart')).series[0].data;
  await page.selectOption('#position-mode','short');await page.fill('#gross-limit','100');await expect(page.locator('#exposure-limit-warning')).toContainText('невозможны');await calculate(page);expect((await chart(page,'weights-chart')).series[0].data.every(p=>p.value>=0)).toBeTruthy();
  await page.fill('#gross-limit','150');await page.fill('#short-limit','0');await expect(page.locator('#exposure-limit-warning')).toContainText('запрещены');await calculate(page);expect((await chart(page,'weights-chart')).series[0].data.every(p=>p.value>=0)).toBeTruthy();
  await page.fill('#min-weight','50');await page.fill('#max-weight','50');await calculate(page);await expect(page.locator('#message')).toContainText('меньше максимального');
  await page.selectOption('#position-mode','long');await page.fill('#max-weight','100');await calculate(page);await expect(page.locator('#gross-limit')).toBeDisabled();await expect(page.locator('#min-weight-label')).toHaveText('Минимальная доля актива, %');expect((await chart(page,'equity-chart')).series[0].data).toEqual(original);
});

test('last comparison chart uses real returns exactly once and annotates all portfolio figures',async({page})=>{
  await ready(page);await page.click('#save-button');await page.selectOption('#position-mode','short');await page.selectOption('#covariance-method','oas');await calculate(page);await tab(page,'graphs');
  await expect(page.locator('#report-comparison-inflation-note')).toContainText('с учётом инфляции');await expect(page.locator('.report-grid').first().locator('.chart-note')).toHaveCount(6);
  const rowLabels=(await chart(page,'report-weights-chart')).series[0].data.map(p=>p.value/100),expected=metrics(estimate(initial,12,{covariance:'oas'}),rowLabels,rf),comparison=await chart(page,'report-comparison-chart');expect(comparison.series).toHaveLength(2);
  comparison.series[0].data.forEach((value,i)=>expect(value).toBeCloseTo((expected.wealth[i]-1)*100,7));expect(comparison.series[1].data).toEqual(metrics(model,solution.weights,rf).wealth.map(v=>(v-1)*100));
  await page.selectOption('#report-comparison-view','wealth');const capital=await chart(page,'report-comparison-chart');capital.series[0].data.forEach((value,i)=>expect(value).toBeCloseTo(expected.wealth[i]*1e6,5));
  await page.click('#language-button');await expect(page.locator('#report-comparison-inflation-note')).toContainText('inflation');expect(await page.locator('#panel-graphs').textContent()).not.toMatch(/[А-Яа-яЁё]/);
});
