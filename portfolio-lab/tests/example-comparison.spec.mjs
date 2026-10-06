import {test,expect} from '@playwright/test';
import XLSX from 'xlsx';
import {readFile} from 'node:fs/promises';
import {examplePortfolio} from '../dist/example-portfolios.js';
import {metrics,demoData} from '../dist/engine.js';

async function tab(page,name){await page.locator('#tab-'+name).click();await expect(page.locator('#panel-'+name)).toBeVisible();}
const rows=page=>page.locator('#comparison-table tbody tr');
const chart=(page,id='report-comparison-chart')=>page.evaluate(id=>echarts.getInstanceByDom(document.getElementById(id)).getOption(),id);

async function expectedExample(profile){
  const book=XLSX.read(await readFile(new URL('../dist/examples/portfolio-'+profile+'.xlsx',import.meta.url)),{type:'buffer',cellDates:true});
  const portfolio=examplePortfolio(XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,defval:null,raw:true}),profile);
  return {portfolio,stat:metrics(portfolio.snapshot.model,portfolio.weights,portfolio.settings.rf,1000000)};
}

test('all three examples compare their own histories and weights, export their sources and remain correct after common settings change',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();await tab(page,'comparison');
  await expect(rows(page)).toHaveCount(4);await expect(page.locator('#comparison-count')).toHaveText('4');
  const expected=await Promise.all(['m2-90-67','m2-60-67','m2-10-00'].map(expectedExample));
  for(const label of ['90,67','60,67','10% · недвижимость'])await expect(rows(page).filter({hasText:label})).toHaveCount(1);
  const downloading=page.waitForEvent('download');await page.locator('#export-button').click();
  const download=await downloading,file=testInfo.outputPath('examples.xlsx');await download.saveAs(file);
  const book=XLSX.read(await readFile(file),{type:'buffer'});
  const capitalRows=XLSX.utils.sheet_to_json(book.Sheets['Реальный капитал'],{header:1});
  for(const {portfolio,stat} of expected){
    const index=capitalRows[0].findIndex(name=>name.includes(portfolio.name));
    expect(capitalRows.slice(1).map(row=>row[index])).toEqual(stat.wealth.map(value=>value*1000000));
  }
  expect(book.SheetNames).toContain('Пример 1 Данные');expect(book.SheetNames).toContain('Пример 2 Данные');expect(book.SheetNames).toContain('Пример 3 Данные');
  await tab(page,'graphs');
  const comparison=await chart(page);expect(comparison.series).toHaveLength(4);
  for(const {portfolio,stat} of expected){
    expect(comparison.series.find(series=>series.name.includes(portfolio.name)).data).toEqual(stat.wealth.map(value=>(value-1)*100));
    const option=page.locator('#report-portfolio option').filter({hasText:portfolio.name});
    await page.locator('#report-portfolio').selectOption(await option.getAttribute('value'));
    expect((await chart(page,'report-return-chart')).series[0].data).toEqual(stat.wealth.map(value=>(value-1)*100));
    expect((await chart(page,'report-weights-chart')).series[0].data.find(item=>item.name.includes('М2')).value).toBeCloseTo(portfolio.weights[0]*100,8);
    expect((await chart(page,'report-frontier-chart')).series[0].data).toEqual(portfolio.snapshot.frontier.map(point=>[point.risk*100,point.return*100]));
  }
  await tab(page,'portfolio');await page.locator('#mode').selectOption('markowitz');await page.locator('#capital').fill('2000000');
  await page.locator('#rf').evaluate(element=>element.closest('details').open=true);await page.locator('#rf').fill('200');await page.locator('#calculate-button').click();
  await expect(page.locator('#message')).not.toHaveClass(/error/);
  await tab(page,'graphs');await page.locator('#report-comparison-view').selectOption('wealth');
  for(const {portfolio,stat} of expected)expect((await chart(page)).series.find(series=>series.name.includes(portfolio.name)).data).toEqual(stat.wealth.map(value=>value*2000000));
  expect(errors).toEqual([]);
});

test('removal, hiding, empty comparison and restoring examples keep the current calculation and report selection usable',async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();
  const original=await page.locator('#expected-income').textContent();
  await tab(page,'comparison');await page.screenshot({path:testInfo.outputPath('mobile-example-comparison.png'),fullPage:true});
  await tab(page,'graphs');const exampleId=await page.locator('#report-portfolio option').nth(1).getAttribute('value');
  await page.locator('#report-portfolio').selectOption(exampleId);
  await tab(page,'comparison');await page.locator('[data-toggle="'+exampleId+'"]').uncheck();
  await expect(rows(page)).toHaveCount(4);await tab(page,'graphs');expect((await chart(page)).series).toHaveLength(3);
  await expect(page.locator('#report-portfolio')).toHaveValue(exampleId);
  await tab(page,'comparison');await page.locator('[data-remove="'+exampleId+'"]').click();
  await expect(rows(page)).toHaveCount(3);await tab(page,'graphs');await expect(page.locator('#report-portfolio')).toHaveValue('current');
  await tab(page,'comparison');
  while(await page.locator('[data-remove]').count())await page.locator('[data-remove]').first().click();
  await expect(rows(page)).toHaveCount(0);await expect(page.locator('#comparison-count')).toHaveText('0');await expect(page.locator('#export-button')).toBeDisabled();
  await expect(page.locator('#comparison-cards')).toContainText('Сравнение пусто');
  await tab(page,'graphs');expect((await chart(page)).series).toHaveLength(0);
  await tab(page,'comparison');await page.locator('#compare-examples-button').click();await expect(rows(page)).toHaveCount(3);
  await page.locator('#compare-examples-button').click();await expect(rows(page)).toHaveCount(3);
  await page.locator('#language-button').click();expect(await page.locator('#panel-comparison').innerText()).not.toMatch(/[А-Яа-яЁё]/);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await tab(page,'portfolio');expect((await page.locator('#expected-income').textContent()).replace(/\D/g,'')).toBe(original.replace(/\D/g,''));
  await page.locator('#save-button').click();await tab(page,'comparison');await expect(rows(page)).toHaveCount(4);
});

test('example graphs align by date and indicator name after a different workbook is loaded',async({page})=>{
  await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();
  const data=demoData(),names=[...data.names];names[1]='Свой индикатор';
  const source=data.rows.slice(12),book=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Дата','ИПЦ',...names],...source.map(row=>[row.date,row.cpi,...row.values])]),'Данные');
  await tab(page,'data');await page.locator('#file-input').setInputFiles({name:'short.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(XLSX.write(book,{type:'buffer',bookType:'xlsx'}))});
  await expect(page.locator('#message')).not.toHaveClass(/error/);await page.locator('#compare-data-examples-button').click();
  await expect(rows(page)).toHaveCount(4);await tab(page,'graphs');const option=await chart(page);
  expect(option.xAxis[0].data).toHaveLength(85);expect(option.series.find(series=>!series.name.includes('Учебный')).data.slice(0,12)).toEqual(Array(12).fill(null));
  await page.locator('#report-comparison-view').selectOption('weights');
  const weights=await chart(page);expect(weights.xAxis[0].data).toContain('Свой индикатор');expect(weights.xAxis[0].data).toContain('Золото');
  expect(weights.series.find(series=>series.name.includes('90,67')).data[weights.xAxis[0].data.indexOf('Свой индикатор')]).toBe(0);
});

test('unavailable default examples leave the app working and can be retried without partial comparison',async({page})=>{
  await page.route('**/portfolio-m2-60-67.xlsx',route=>route.fulfill({status:404,body:'missing'}));
  await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();await tab(page,'comparison');await expect(rows(page)).toHaveCount(1);
  await page.locator('#compare-examples-button').click();await expect(page.locator('#message')).toHaveClass(/error/);await expect(rows(page)).toHaveCount(1);
  await page.unroute('**/portfolio-m2-60-67.xlsx');await page.locator('#compare-examples-button').click();await expect(rows(page)).toHaveCount(4);
});
