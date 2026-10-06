import {test,expect} from '@playwright/test';
import XLSX from 'xlsx';
import {readFile} from 'node:fs/promises';
import {demoData} from '../dist/engine.js';

const holdoutCharts=['backtest-return-chart','backtest-drawdown-chart','backtest-weights-chart'];
const workbookRows=book=>XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1});
async function openTab(page,name) {
  await page.locator('#tab-'+name).click();
  await expect(page.locator('#panel-'+name)).toBeVisible();
}
async function start(page) {
  await page.goto('/');
  await expect(page.locator('#equity-chart svg')).toBeVisible();
}
async function dashboard(page) {
  return page.evaluate(()=>({
    title:document.getElementById('current-title').textContent,
    metrics:['expected-income','expected-rate','risk-value','drawdown-value','recovery-value'].map(id=>document.getElementById(id).textContent),
    series:['frontier-chart','equity-chart','weights-chart'].map(id=>echarts.getInstanceByDom(document.getElementById(id)).getOption().series.map(series=>series.data)),
    saved:document.getElementById('comparison-table').querySelector('tbody').textContent
  }));
}
async function chartOptions(page,ids=holdoutCharts) {
  return page.evaluate(ids=>ids.map(id=>echarts.getInstanceByDom(document.getElementById(id)).getOption()),ids);
}
async function runHoldout(page) {
  await openTab(page,'backtest');
  await page.locator('#backtest-target-return').fill('8');
  await page.locator('#backtest-run-button').click();
  await expect(page.locator('#backtest-run-button')).toBeEnabled();
  await expect(page.locator('#backtest-table tbody tr')).toHaveCount(5);
  for(const id of holdoutCharts)await expect(page.locator('#'+id+' svg')).toBeVisible();
}
async function downloadWorkbook(page,testInfo,selector,name) {
  const waiting=page.waitForEvent('download');
  await page.locator(selector).click();
  const download=await waiting,file=testInfo.outputPath(name);
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  await download.saveAs(file);
  return {file,book:XLSX.read(await readFile(file),{type:'buffer'})};
}
async function noOverflow(page) {
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
}
const officialFixture=()=>({
  ...demoData(),demo:false,frequency:12,source:'ЦБ РФ · Мосбиржа',
  provenance:[
    {name:'Банк России',url:'https://www.cbr.ru/development/sxml/',indicators:['М2','Золото','Валюты'],method:'Последнее опубликованное наблюдение месяца'},
    {name:'Московская биржа',url:'https://www.moex.com/a2193',indicators:['Индексы'],method:'Закрытие последнего торгового дня месяца'}
  ],
  period:{from:'2019-01',to:'2026-01'},downloadedAt:'2026-10-06T10:00:00.000Z',
  notes:['М2 — макроэкономический индикатор. Доходности рассчитываются после поправки на ИПЦ.']
});

test('both downloadable teaching examples load their Sharpe profile and requested M2 weights',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await start(page);
  for(const [profile,weight] of [['m2-90-67',90.67],['m2-60-67',60.67]]) {
    await openTab(page,'data');
    const {file,book}=await downloadWorkbook(page,testInfo,'a[href$="portfolio-'+profile+'.xlsx"]',profile+'.xlsx');
    expect(book.SheetNames).toContain('Параметры');
    const rows=workbookRows(book);
    expect(rows.length).toBeGreaterThan(25);
    expect(rows[0].length).toBe(12);expect(rows[0][2]).toMatch(/М2|M2/);
    expect(rows.slice(1).every(row=>row.slice(1).every(value=>Number.isFinite(value)&&value>0))).toBeTruthy();
    await page.locator('[data-load-example="'+profile+'"]').click();
    await expect(page.locator('#current-title')).toHaveText('Максимум Шарпа');
    await expect(page.locator('#indicators-table tbody tr').first()).toContainText(String(weight.toFixed(2)).replace('.',','));
    await openTab(page,'portfolio');
    await expect(page.locator('#mode')).toHaveValue('sharpe');
    await expect(page.locator('#rf')).toHaveValue('8');
    await expect(page.locator('#frequency')).toHaveValue('12');
    const chart=await page.evaluate(()=>echarts.getInstanceByDom(document.getElementById('weights-chart')).getOption().series[0].data);
    expect(chart.find(item=>/М2|M2/.test(item.name)).value).toBeCloseTo(weight,2);
    await page.locator('#mode').selectOption('markowitz');
    await page.locator('#rf').evaluate(element=>{element.closest('details').open=true;});
    await page.locator('#rf').fill('12');
    await openTab(page,'data');await page.locator('#file-input').setInputFiles(file);
    await expect(page.locator('#mode')).toHaveValue('sharpe');
    await expect(page.locator('#rf')).toHaveValue('8');
    await expect(page.locator('#current-title')).toHaveText('Максимум Шарпа');
    await expect(page.locator('#indicators-table tbody tr').first()).toContainText(String(weight.toFixed(2)).replace('.',','));
  }
  expect(errors).toEqual([]);
});

test('holdout compares frozen training weights against equal weights and preserves current results across languages',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await start(page);const original=await dashboard(page);
  // Unsaved edits to the main form must not affect the committed shared parameters.
  await page.locator('#capital').fill('2000000');
  await openTab(page,'backtest');await expect(page.locator('#backtest-split')).toHaveValue('2023-11-30');
  await runHoldout(page);
  expect(await dashboard(page)).toEqual(original);
  await expect(page.locator('#backtest-table')).toContainText(/равн|дол/i);
  const charts=await chartOptions(page);
  expect(charts.map(chart=>chart.series.length)).toEqual([5,5,5]);
  const testDates=demoData().rows.slice(58).map(row=>row.date);
  expect(charts[0].xAxis[0].data).toEqual(testDates);
  expect(charts[1].xAxis[0].data).toEqual(testDates);
  expect(charts[0].series.every(series=>series.data.length===testDates.length&&Math.abs(series.data[0])<1e-9)).toBeTruthy();
  expect(charts[1].series.every(series=>series.data.length===testDates.length&&Math.abs(series.data[0])<1e-9)).toBeTruthy();
  expect(charts[2].series.at(-1).data).toEqual(Array(10).fill(10));
  const {book}=await downloadWorkbook(page,testInfo,'#backtest-export-button','holdout.xlsx');
  const allRows=book.SheetNames.map(name=>XLSX.utils.sheet_to_json(book.Sheets[name],{header:1}));
  expect(allRows.some(rows=>rows.slice(1).some(row=>row[0]===testDates[0]))).toBeTruthy();
  expect(allRows.some(rows=>rows.some(row=>row.includes(1000000)))).toBeTruthy();
  await page.locator('#language-button').click();await expect(page.locator('html')).toHaveAttribute('lang','en');
  await expect(page.locator('#panel-backtest')).toBeVisible();
  expect(await page.locator('#panel-backtest').innerText()).not.toMatch(/[А-Яа-яЁё]/);
  const translated=await chartOptions(page);
  expect(translated.map(chart=>chart.series.map(series=>series.data))).toEqual(charts.map(chart=>chart.series.map(series=>series.data)));
  await page.setViewportSize({width:390,height:844});await noOverflow(page);
  await page.screenshot({path:testInfo.outputPath('mobile-holdout-english.png'),fullPage:true});
  await page.locator('#language-button').click();
  await expect(page.locator('#panel-backtest')).toBeVisible();
  expect(errors).toEqual([]);
});

test('invalid holdout boundaries keep the dashboard and new imports clear stale analysis',async({page})=>{
  await start(page);await runHoldout(page);const original=await dashboard(page);
  await page.locator('#backtest-split').fill('2019-06-30');
  await page.locator('#backtest-run-button').click();
  await expect(page.locator('#backtest-run-button')).toBeEnabled();
  expect(await page.locator('#backtest-split').evaluate(input=>input.validity.rangeUnderflow)).toBeTruthy();
  await expect(page.locator('#backtest-table tbody tr')).toHaveCount(5);
  expect(await dashboard(page)).toEqual(original);
  await page.locator('#backtest-split').fill('2023-11-30');
  await page.locator('#backtest-target-return').fill('10000');
  await page.locator('#backtest-run-button').click();
  await expect(page.locator('#backtest-table tbody tr')).toHaveCount(4);
  await expect(page.locator('#panel-backtest')).toContainText(/недостижим/i);
  const data=demoData(),book=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Дата','ИПЦ',...data.names],...data.rows.map(row=>[row.date,row.cpi,...row.values])]),'Данные');
  await openTab(page,'data');
  await page.locator('#file-input').setInputFiles({name:'fresh-data.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(XLSX.write(book,{type:'buffer',bookType:'xlsx'}))});
  await expect(page.locator('#data-badge')).toHaveText('Ваш Excel');
  await openTab(page,'backtest');
  await expect(page.locator('#backtest-table tbody tr')).toHaveCount(0);
  await expect(page.locator('#backtest-export-button')).toBeDisabled();
});

test('official data import shows sources, downloads reusable Excel and clears prior holdout',async({page},testInfo)=>{
  const errors=[],requests=[];page.on('pageerror',error=>errors.push(error.message));
  const fixture=officialFixture();
  await page.route('**/api/market-data**',route=>{
    requests.push(new URL(route.request().url()));
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(fixture)});
  });
  await start(page);await openTab(page,'data');
  await page.locator('[data-load-example="m2-90-67"]').click();
  await expect(page.locator('#message')).toBeVisible();
  await expect(page.locator('#message')).toContainText('90,67');
  await runHoldout(page);await openTab(page,'data');
  await expect(page.locator('#online-excel-button')).toBeHidden();
  await page.locator('#online-from').fill('2019-01');await page.locator('#online-to').fill('2026-01');
  await page.locator('#online-load-button').click();
  await expect(page.locator('#data-badge')).toHaveText('Официальные данные');
  await expect(page.locator('#message')).toBeHidden();
  await expect(page.locator('#online-load-button')).toBeEnabled();
  await expect(page.locator('#online-excel-button')).toBeEnabled();
  expect(requests).toHaveLength(1);
  expect(requests[0].searchParams.get('from')).toBe('2019-01');
  expect(requests[0].searchParams.get('to')).toBe('2026-01');
  await expect(page.locator('#online-provenance')).toContainText('Банк России');
  await expect(page.locator('#online-provenance')).toContainText('Московская биржа');
  await expect(page.locator('#online-provenance a[href^="https://www.cbr.ru/"]')).toHaveCount(1);
  await expect(page.locator('#online-provenance a[href^="https://www.moex.com/"]')).toHaveCount(1);
  const {file,book}=await downloadWorkbook(page,testInfo,'#online-excel-button','official-data.xlsx');
  const rows=workbookRows(book);
  expect(rows[0].slice(0,2)).toEqual(['Дата','ИПЦ']);expect(rows).toHaveLength(fixture.rows.length+1);
  expect(rows[1].slice(0,2)).toEqual([fixture.rows[0].date,fixture.rows[0].cpi]);
  await openTab(page,'backtest');
  await expect(page.locator('#backtest-table tbody tr')).toHaveCount(0);
  await expect(page.locator('#backtest-export-button')).toBeDisabled();
  await openTab(page,'data');await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('#indicators-table tbody tr')).toHaveCount(10);
  await expect(page.locator('#message')).not.toHaveClass(/error/);
  expect(errors).toEqual([]);
});

test('failed public data loads preserve the previous data and analysis on mobile',async({page})=>{
  let calls=0;const fixture=officialFixture();
  await page.route('**/api/market-data**',route=>{
    calls++;
    return route.fulfill(calls===1?{status:200,contentType:'application/json',body:JSON.stringify(fixture)}:{status:400,contentType:'application/json',body:JSON.stringify({error:'Выбранный период недоступен. Измените даты и повторите загрузку.'})});
  });
  await page.setViewportSize({width:390,height:844});await start(page);await openTab(page,'data');
  await page.locator('#online-from').fill('2019-01');await page.locator('#online-to').fill('2026-01');
  await page.locator('#online-load-button').click();await expect(page.locator('#data-badge')).toHaveText('Официальные данные');
  await runHoldout(page);const original=await dashboard(page),previousCharts=await chartOptions(page);
  await openTab(page,'data');const dataInfo=await page.locator('#data-info').textContent(),provenance=await page.locator('#online-provenance').textContent();
  await page.locator('#online-load-button').click();
  await expect(page.locator('#online-status')).toContainText('недоступен');
  await expect(page.locator('#online-load-button')).toBeEnabled();
  await expect(page.locator('#online-excel-button')).toBeEnabled();
  await expect(page.locator('#data-badge')).toHaveText('Официальные данные');
  await expect(page.locator('#data-info')).toHaveText(dataInfo);
  await expect(page.locator('#online-provenance')).toHaveText(provenance);
  expect(await dashboard(page)).toEqual(original);
  await noOverflow(page);
  await openTab(page,'backtest');await expect(page.locator('#backtest-table tbody tr')).toHaveCount(5);
  expect((await chartOptions(page)).map(chart=>chart.series.map(series=>series.data))).toEqual(previousCharts.map(chart=>chart.series.map(series=>series.data)));
  await noOverflow(page);
});
