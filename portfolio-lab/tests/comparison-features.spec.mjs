import {test,expect} from '@playwright/test';
import XLSX from 'xlsx';
import {readFile} from 'node:fs/promises';
import {demoData,estimate,metrics} from '../dist/engine.js';
const rows=page=>page.locator('#comparison-table tbody tr');
const chart=page=>page.evaluate(()=>echarts.getInstanceByDom(document.getElementById('report-comparison-chart')).getOption());
async function tab(page,name){await page.locator('#tab-'+name).click();await expect(page.locator('#panel-'+name)).toBeVisible();}
async function start(page){await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();await tab(page,'comparison');}
async function period(page,from='2020-01-31',to='2024-01-31'){
  await page.locator('#comparison-from').fill(from);await page.locator('#comparison-to').fill(to);await page.locator('#comparison-period-apply').click();
  await expect(page.locator('#message')).not.toHaveClass(/error/);await expect(page.locator('#comparison-period-status')).toContainText(from+' — '+to);
}
async function openLibrary(page){await page.locator('.comparison-library').evaluate(element=>element.open=true);}
async function table(page){return page.locator('#comparison-table tbody').innerText();}

test('differences follow the selected baseline, rank direction, and stay accessible with highlight disabled and translated',async({page})=>{
  await start(page);await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).filter({has:page.locator('[data-metric="expectedIncome"].metric-best')})).toContainText('10% · недвижимость');
  await expect(page.locator('[data-baseline="true"]')).toContainText('текущий');
  await expect(page.locator('[data-baseline="true"] .metric-difference')).toHaveCount(0);
  const baseline=await rows(page).filter({hasText:'60,67'}).getAttribute('data-portfolio-id');
  await page.locator('#comparison-baseline').selectOption(baseline);await expect(page.locator('[data-baseline="true"]')).toContainText('60,67');
  await expect(rows(page).first().locator('[data-metric="expectedIncome"] .metric-difference')).toContainText('−');
  await page.locator('#comparison-highlight').uncheck();await expect(page.locator('#comparison-table .metric-best, #comparison-table .metric-worst')).toHaveCount(0);
  await expect(page.locator('#comparison-table .metric-difference').first()).toBeVisible();
  await page.locator('#language-button').click();expect(await page.locator('#panel-comparison').innerText()).not.toMatch(/[А-Яа-яЁё]/);
  await expect(page.locator('#comparison-baseline')).toHaveValue(baseline);await expect(page.locator('#comparison-highlight')).not.toBeChecked();
});

test('a common period recalculates the table and exported charts, rebases capital and preserves the main calculation',async({page},testInfo)=>{
  await start(page);
  const income=await page.locator('#expected-income').textContent(),original=await table(page);
  await period(page);await expect(page.locator('#expected-income')).toHaveText(income);expect(await table(page)).not.toBe(original);
  await tab(page,'graphs');const option=await chart(page);
  expect(option.xAxis[0].data).toHaveLength(49);expect(option.xAxis[0].data[0]).toBe('2020-01-31');expect(option.xAxis[0].data.at(-1)).toBe('2024-01-31');
  for(const series of option.series)expect(series.data[0]).toBe(0);
  const weights=await page.evaluate(()=>echarts.getInstanceByDom(document.getElementById('weights-chart')).getOption().series[0].data);
  const data=demoData(),model=estimate({...data,rows:data.rows.slice(12,61)}),portfolioWeights=model.names.map(name=>(weights.find(item=>item.name===name)?.value||0)/100);
  const expected=metrics(model,portfolioWeights,1.08/(1+model.inflation)-1,1e6);
  const current=option.series.find(series=>!series.name.includes('Учебный пример'));
  current.data.forEach((value,i)=>expect(value).toBeCloseTo((expected.wealth[i]-1)*100,8));
  await tab(page,'comparison');const downloading=page.waitForEvent('download');await page.locator('#export-button').click();const download=await downloading;
  const file=testInfo.outputPath('common-period.xlsx');await download.saveAs(file);const workbook=XLSX.read(await readFile(file),{type:'buffer'});
  const capital=XLSX.utils.sheet_to_json(workbook.Sheets['Реальный капитал'],{header:1});expect(capital).toHaveLength(50);
  expect(capital[1].slice(1)).toEqual([1e6,1e6,1e6,1e6]);
  const before=await table(page);await page.locator('#comparison-from').fill('2025-07-31');await page.locator('#comparison-to').fill('2026-01-31');await page.locator('#comparison-period-apply').click();
  await expect(page.locator('#message')).toHaveClass(/error/);await expect(page.locator('#message')).toContainText('13');expect(await table(page)).toBe(before);
  await page.locator('#comparison-period-reset').click();expect(await table(page)).toBe(original);
  const shorter=XLSX.utils.book_new();XLSX.utils.book_append_sheet(shorter,XLSX.utils.aoa_to_sheet([['Дата','ИПЦ',...data.names],...data.rows.slice(12).map(row=>[row.date,row.cpi,...row.values])]),'Данные');
  await tab(page,'data');await page.locator('#file-input').setInputFiles({name:'shorter.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(XLSX.write(shorter,{type:'buffer',bookType:'xlsx'}))});
  await expect(page.locator('#message')).not.toHaveClass(/error/);await tab(page,'comparison');
  await expect(page.locator('#comparison-from')).toHaveValue('2020-01-31');await expect(page.locator('#comparison-to')).toHaveValue('2026-01-31');

});

test('named sets survive reload, restore removed current, hidden examples, common period and baseline, and update and delete without changing results',async({page})=>{
  await start(page);await period(page);
  const exampleId=await rows(page).filter({hasText:'60,67'}).getAttribute('data-portfolio-id');
  await page.locator('#comparison-baseline').selectOption(exampleId);await page.locator('[data-toggle="'+exampleId+'"]').uncheck();await page.locator('[data-remove="current"]').click();
  const before=await table(page);await openLibrary(page);await page.locator('#comparison-set-name').fill('Мой набор <test>');await page.locator('#comparison-set-save').click();
  await expect(page.locator('#message')).not.toHaveClass(/error/);await expect(page.locator('#comparison-set-select option')).toHaveCount(2);
  await page.locator('#comparison-set-save').click();await expect(page.locator('#comparison-set-select option')).toHaveCount(2);
  const setId=await page.locator('#comparison-set-select').inputValue();await page.reload();await expect(rows(page)).toHaveCount(4);await tab(page,'comparison');
  await expect(rows(page)).toHaveCount(4);await openLibrary(page);await page.locator('#comparison-set-select').selectOption(setId);await page.locator('#comparison-set-open').click();
  await expect(page.locator('#message')).not.toHaveClass(/error/);await expect(rows(page)).toHaveCount(3);expect(await table(page)).toBe(before);
  await expect(page.locator('#comparison-baseline')).toHaveValue(exampleId);await expect(page.locator('[data-toggle="'+exampleId+'"]')).not.toBeChecked();
  await expect(page.locator('#comparison-from')).toHaveValue('2020-01-31');await expect(page.locator('#comparison-to')).toHaveValue('2024-01-31');
  await tab(page,'graphs');expect((await chart(page)).series).toHaveLength(2);expect((await chart(page)).xAxis[0].data).toHaveLength(49);
  await tab(page,'comparison');await page.locator('#comparison-set-delete').click();await expect(page.locator('#comparison-set-select option')).toHaveCount(1);expect(await table(page)).toBe(before);
});

test('damaged sets and storage quota failures preserve current data, while controls fit a mobile dark theme',async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});await start(page);await openLibrary(page);
  await page.locator('#comparison-set-name').fill('Проверка');await page.locator('#comparison-set-save').click();const before=await table(page);
  await page.evaluate(()=>{const key='portfolio-lab.comparison-sets.v1',sets=JSON.parse(localStorage.getItem(key));sets[0].payload.current.weights[0]=-1;localStorage.setItem(key,JSON.stringify(sets));});
  await page.locator('#comparison-set-open').click();await expect(page.locator('#message')).toHaveClass(/error/);expect(await table(page)).toBe(before);
  const stored=await page.evaluate(()=>localStorage.getItem('portfolio-lab.comparison-sets.v1'));
  await page.evaluate(()=>Storage.prototype.setItem=function(){throw new DOMException('full','QuotaExceededError');});
  await page.locator('#comparison-set-save').click();await expect(page.locator('#message')).toContainText('Недостаточно места');
  expect(await page.evaluate(()=>localStorage.getItem('portfolio-lab.comparison-sets.v1'))).toBe(stored);expect(await table(page)).toBe(before);
  await page.locator('#language-button').click();await page.locator('#theme-button').click();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:testInfo.outputPath('mobile-saved-comparison.png'),fullPage:true});
});
