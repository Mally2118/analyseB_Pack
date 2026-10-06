import {test,expect} from '@playwright/test';
import XLSX from 'xlsx';
import {readFile} from 'node:fs/promises';

const modes=['markowitz','sharpe','risk','return'];
const reportCharts=['report-frontier-chart','report-return-chart','report-weights-chart','report-capital-chart','report-drawdown-chart','report-recovery-chart'];
const cards=page=>page.locator('#comparison-cards .portfolio-chip');

async function openTab(page,name) {
  await page.locator('#tab-'+name).click();
  await expect(page.locator('#panel-'+name)).toBeVisible();
  await expect(page.locator('#tab-'+name)).toHaveAttribute('aria-selected','true');
}
async function dashboard(page) {
  return page.evaluate(()=>({
    title:document.getElementById('current-title').textContent,
    metrics:['expected-income','expected-rate','risk-value','drawdown-value','recovery-value'].map(id=>document.getElementById(id).textContent),
    series:['frontier-chart','equity-chart','weights-chart'].map(id=>echarts.getInstanceByDom(document.getElementById(id)).getOption().series.map(series=>series.data)),
  }));
}
async function savedState(page) {
  return {cards:await cards(page).allTextContents(),rows:await page.locator('#comparison-table tbody').innerText(),dashboard:await dashboard(page)};
}
async function addCriterion(page,mode) {
  await page.locator('[data-add-criterion="'+mode+'"]').click();
  await expect(page.locator('[data-add-criterion="'+mode+'"]').first()).toBeEnabled();
  await expect(page.locator('#message')).toBeVisible();
  await expect(page.locator('#message')).not.toHaveClass(/error/);
  await expect(page.locator('#panel-comparison')).toBeVisible();
}
async function expectMessageInViewport(page) {
  await expect.poll(()=>page.locator('#message').evaluate(element=>{
    const bounds=element.getBoundingClientRect();
    return bounds.top>=-1&&bounds.bottom<=innerHeight+1&&bounds.left>=-1&&bounds.right<=innerWidth+1;
  })).toBeTruthy();
}

test('downloadable Excel example imports, compares all four criteria and keeps report charts separate',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();
  await openTab(page,'data');
  const link=page.locator('#example-download');
  await expect(link).toBeVisible();await expect(link).toHaveAttribute('href',/examples\/portfolio-example\.xlsx$/);
  const waiting=page.waitForEvent('download');await link.click();const download=await waiting;
  const file=testInfo.outputPath('portfolio-example.xlsx');await download.saveAs(file);
  const workbook=XLSX.read(await readFile(file),{type:'buffer'});
  const rows=XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]],{header:1});
  expect(rows).toHaveLength(86);expect(rows.every(row=>row.length===12)).toBeTruthy();
  expect(rows[0].slice(0,2)).toEqual(['Дата','ИПЦ']);expect(rows[0][2]).toMatch(/М2|M2/);
  expect(rows.slice(1).every(row=>row.slice(1).every(value=>Number.isFinite(value)&&value>0))).toBeTruthy();
  await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('#data-badge')).toHaveText('Ваш Excel');
  await expect(page.locator('#message')).not.toHaveClass(/error/);
  await expect(page.locator('#indicators-table tbody tr')).toHaveCount(10);
  await expect(page.locator('#indicators-table tbody tr').first()).toContainText(/М2|M2/);
  await openTab(page,'portfolio');const current=await dashboard(page);
  await openTab(page,'comparison');await expect(cards(page)).toHaveCount(0);
  await expect(page.locator('#compare-lambda')).toHaveValue('3');
  await expect(page.locator('#compare-target-return')).toHaveValue('10');
  await expect(page.locator('#compare-target-risk')).toHaveValue('20');
  for(const mode of modes)await expect(page.locator('[data-add-criterion="'+mode+'"]').first()).toBeVisible();
  await page.locator('#compare-all-button').click();
  await expect(cards(page)).toHaveCount(4);await expect(page.locator('#comparison-table tbody tr')).toHaveCount(5);
  await expect(page.locator('#message')).not.toHaveClass(/error/);await expect(page.locator('#message')).toContainText(/4|четыр/i);
  await expect(page.locator('#panel-comparison')).toBeVisible();await expect(page.locator('#panel-comparison [data-open-tab="graphs"]').first()).toBeVisible();
  expect(await dashboard(page)).toEqual(current);
  const names=await cards(page).allTextContents();
  for(const name of ['Марковиц','Максимум Шарпа','Эффективный риск','Эффективная доходность'])expect(names.filter(text=>text.includes(name))).toHaveLength(1);
  await page.locator('#compare-all-button').click();
  await expect(cards(page)).toHaveCount(4);await expect(page.locator('#comparison-table tbody tr')).toHaveCount(5);
  await openTab(page,'graphs');await expect(page.locator('#report-portfolio option')).toHaveCount(5);
  for(const id of [...reportCharts,'report-comparison-chart'])await expect(page.locator('#'+id+' svg')).toBeVisible();
  const counts=await page.evaluate(ids=>ids.map(id=>echarts.getInstanceByDom(document.getElementById(id)).getOption().series.length),[...reportCharts,'report-comparison-chart']);
  expect(counts).toEqual([2,1,1,1,1,1,5]);
  expect(await page.evaluate(ids=>{const comparison=document.getElementById('report-comparison-chart').getBoundingClientRect();return ids.every(id=>document.getElementById(id).getBoundingClientRect().bottom<=comparison.top);},reportCharts)).toBeTruthy();
  await openTab(page,'data');await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('#message')).not.toHaveClass(/error/);await openTab(page,'comparison');
  await expect(cards(page)).toHaveCount(0);await expect(page.locator('#comparison-table tbody tr')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('criterion cards add directly, distinguish risk settings and translate without replacing the current portfolio',async({page})=>{
  await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();const current=await dashboard(page);
  await openTab(page,'comparison');await expect(cards(page)).toHaveCount(1);
  await addCriterion(page,'risk');await expect(cards(page)).toHaveCount(2);
  await addCriterion(page,'risk');await expect(cards(page)).toHaveCount(2);
  await page.locator('#compare-lambda').fill('4');await addCriterion(page,'markowitz');await expect(cards(page)).toHaveCount(3);
  await page.locator('#compare-lambda').fill('7');await addCriterion(page,'markowitz');await expect(cards(page)).toHaveCount(4);
  await expect(cards(page).filter({hasText:'λ = 4'})).toHaveCount(1);await expect(cards(page).filter({hasText:'λ = 7'})).toHaveCount(1);
  expect(await dashboard(page)).toEqual(current);
  const rows=await page.locator('#comparison-table tbody tr').allTextContents();
  await page.locator('#language-button').click();await expect(page.locator('html')).toHaveAttribute('lang','en');
  await expect(page.locator('#panel-comparison')).toBeVisible();await expect(cards(page)).toHaveCount(4);
  await expect(page.locator('#compare-lambda')).toHaveValue('7');
  expect(await page.locator('#panel-comparison').innerText()).not.toMatch(/[А-Яа-яЁё]/);
  await expect(page.locator('#message')).not.toHaveClass(/error/);
  await page.locator('#language-button').click();await expect(page.locator('html')).toHaveAttribute('lang','ru');
  expect(await page.locator('#comparison-table tbody tr').allTextContents()).toEqual(rows);
  expect(await dashboard(page)).toEqual(current);
});

test('invalid and infeasible comparison batches preserve saved results, and unrelated controls do not block individual criteria',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();await openTab(page,'comparison');
  await addCriterion(page,'sharpe');const before=await savedState(page);
  await page.locator('#compare-lambda').fill('5');await page.locator('#compare-target-return').fill('');
  await page.locator('#compare-all-button').click();
  await expect(page.locator('#message')).toHaveClass(/error/);await expect(page.locator('#message')).toContainText(/числов|доходност/i);
  await expectMessageInViewport(page);
  await page.locator('#language-button').click();
  await expect(page.locator('#message')).toContainText('Minimum return, % / year');
  expect(await page.locator('#message').innerText()).not.toMatch(/[А-Яа-яЁё]/);
  await page.locator('#language-button').click();await expect(page.locator('#message')).toContainText('Минимальная доходность, % / год');
  await page.locator('#language-button').click();
  await page.locator('#compare-target-return').fill('10');await page.locator('#compare-lambda').fill('');
  await page.locator('#compare-all-button').click();
  await expect(page.locator('#message')).toHaveClass(/error/);await expect(page.locator('#message')).toContainText('Risk aversion λ');
  expect(await page.locator('#message').innerText()).not.toMatch(/[А-Яа-яЁё]/);await expectMessageInViewport(page);
  await page.locator('#language-button').click();await expect(page.locator('#message')).toContainText('Осторожность λ');
  await page.locator('#compare-lambda').fill('5');
  expect(await savedState(page)).toEqual(before);await expect(page.locator('#panel-comparison')).toBeVisible();
  await page.locator('#compare-target-return').fill('1000000');await page.locator('#compare-all-button').click();
  await expect(page.locator('#message')).toHaveClass(/error/);await expect(page.locator('#message')).toContainText(/недостижим/i);
  await expectMessageInViewport(page);
  expect(await savedState(page)).toEqual(before);
  await page.locator('#compare-target-return').fill('10');await page.locator('#compare-target-risk').fill('0');
  await page.locator('#compare-all-button').click();
  await expect(page.locator('#message')).toHaveClass(/error/);await expect(page.locator('#message')).toContainText(/минимально достижим/i);
  await expectMessageInViewport(page);
  expect(await savedState(page)).toEqual(before);
  await addCriterion(page,'markowitz');await expect(cards(page)).toHaveCount(3);
  expect(await dashboard(page)).toEqual(before.dashboard);
});

test('comparison capacity errors leave the complete previous comparison intact and controls fit mobile',async({page},testInfo)=>{
  test.setTimeout(45000);
  await page.setViewportSize({width:390,height:844});await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();
  await openTab(page,'comparison');
  for(let lambda=4;lambda<=10;lambda++) {await page.locator('#compare-lambda').fill(String(lambda));await addCriterion(page,'markowitz');}
  await expect(cards(page)).toHaveCount(8);await expect(page.locator('#comparison-table tbody tr')).toHaveCount(9);
  const before=await savedState(page);
  await page.locator('#compare-all-button').click();
  await expect(page.locator('#message')).toHaveClass(/error/);await expect(page.locator('#message')).toContainText('8');
  expect(await savedState(page)).toEqual(before);
  await addCriterion(page,'markowitz');await expect(cards(page)).toHaveCount(8);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:testInfo.outputPath('mobile-comparison.png'),fullPage:true});
});

test('comparison uses the last applied common settings and preserves all results when Sharpe becomes infeasible',async({page})=>{
  await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();const current=await dashboard(page);
  await page.locator('#capital').fill('2000000');await openTab(page,'comparison');await addCriterion(page,'risk');
  await expect(cards(page)).toHaveCount(2);expect(await dashboard(page)).toEqual(current);
  await expect(page.locator('#comparison-context')).toBeVisible();
  await openTab(page,'portfolio');await page.locator('#calculate-button').click();
  await expect(page.locator('#message')).not.toHaveClass(/error/);
  await expect(page.locator('#expected-income')).not.toHaveText(current.metrics[0]);
  await openTab(page,'comparison');await expect(cards(page)).toHaveCount(2);
  await expect(page.locator('#comparison-context')).toContainText(/2[ \u00a0\u202f]000[ \u00a0\u202f]000/);
  await page.locator('#compare-all-button').click();await expect(cards(page)).toHaveCount(4);
  await openTab(page,'portfolio');await page.locator('#mode').selectOption('markowitz');
  await page.locator('#rf').evaluate(element=>{const details=element.closest('details');if(details)details.open=true;});
  await page.locator('#rf').fill('200');await page.locator('#calculate-button').click();
  await expect(page.locator('#current-title')).toHaveText('Марковиц');await expect(page.locator('#message')).not.toHaveClass(/error/);
  await openTab(page,'comparison');const before=await savedState(page);
  await page.locator('#compare-lambda').fill('5');await page.locator('#compare-all-button').click();
  await expect(page.locator('#message')).toHaveClass(/error/);await expect(page.locator('#message')).toContainText(/безрисков|Шарпа/i);
  expect(await savedState(page)).toEqual(before);await expect(page.locator('#panel-comparison')).toBeVisible();
});
