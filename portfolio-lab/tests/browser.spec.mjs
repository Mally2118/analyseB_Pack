import {test,expect} from '@playwright/test';
import XLSX from 'xlsx';
import {readFile} from 'node:fs/promises';

const tabs=['portfolio','graphs','comparison','backtest','data'];
const primaryCharts=['frontier-chart','equity-chart','weights-chart'];
const individualCharts=['report-frontier-chart','report-return-chart','report-weights-chart','report-capital-chart','report-drawdown-chart','report-recovery-chart'];
const reportCharts=[...individualCharts,'report-comparison-chart'];
async function activateTab(page,name) {
  await page.locator('#tab-'+name).click();
  for(const tab of tabs) {
    await expect(page.locator('#tab-'+tab)).toHaveAttribute('aria-selected',String(tab===name));
    if(tab===name)await expect(page.locator('#panel-'+tab)).toBeVisible();
    else await expect(page.locator('#panel-'+tab)).toBeHidden();
  }
  if(name==='graphs')for(const id of reportCharts)await expect(page.locator('#'+id+' svg')).toBeVisible();
  if(name==='portfolio')await expect(page.locator('#equity-chart svg')).toBeVisible();
}
const chartSeries=(page,ids)=>page.evaluate(ids=>ids.map(id=>echarts.getInstanceByDom(document.getElementById(id)).getOption().series),ids);
const chartCounts=async(page,ids)=>(await chartSeries(page,ids)).map(series=>series.length);
async function expectNoOverflow(page) {
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
}
async function downloadSvg(page,testInfo,id) {
  const downloading=page.waitForEvent('download',{timeout:10000});
  await page.locator('[data-download="'+id+'"]').click();
  const download=await downloading;
  expect(download.suggestedFilename()).toMatch(/\.svg$/);
  const file=testInfo.outputPath(id+'.svg');await download.saveAs(file);
  const svg=await readFile(file,'utf8');expect(svg).toContain('<svg');expect(svg).toContain('</svg>');
  return {download,svg};
}

test('four criteria, saved portfolios, validation and Excel roundtrip work across tabs',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#current-title')).toHaveText('Максимум Шарпа');
  await expect(page.locator('#indicators-table tbody tr')).toHaveCount(10);
  await expect(page.locator('#comparison-table tbody tr')).toHaveCount(2);
  await expect(page.locator('#equity-chart svg')).toBeVisible();
  await expect(page.locator('#panel-portfolio')).toBeVisible();
  await expect(page.locator('#message')).toBeHidden();
  await page.screenshot({path:testInfo.outputPath('desktop.png'),fullPage:true});
  for(const mode of ['markowitz','sharpe','risk','return']) {
    await page.selectOption('#mode',mode);
    await page.click('#calculate-button');
    await expect(page.locator('#calculate-button')).toBeEnabled();
    await expect(page.locator('#current-title')).toHaveText({markowitz:'Марковиц',sharpe:'Максимум Шарпа',risk:'Эффективный риск',return:'Эффективная доходность'}[mode]);
    await expect(page.locator('#message')).not.toHaveClass(/error/);
    await page.click('#save-button');
    await expect(page.locator('#panel-portfolio')).toBeVisible();
  }
  await activateTab(page,'comparison');
  await expect(page.locator('#comparison-table tbody tr')).toHaveCount(6);
  await activateTab(page,'graphs');
  await expect(page.locator('#report-portfolio option')).toHaveCount(6);
  expect(await chartCounts(page,individualCharts)).toEqual([2,1,1,1,1,1]);
  expect(await chartCounts(page,['report-comparison-chart'])).toEqual([6]);
  await activateTab(page,'portfolio');
  await page.locator('[data-view="drawdown"]').click();
  await expect(page.locator('[data-view="drawdown"]')).toHaveClass('active');
  const previous=await page.locator('#risk-value').textContent();
  await page.selectOption('#mode','return');await page.fill('#target-risk','0');await page.click('#calculate-button');
  await expect(page.locator('#message')).toHaveClass(/error/);
  await expect(page.locator('#risk-value')).toHaveText(previous);
  await page.selectOption('#mode','markowitz');
  await expect(page.locator('#first-indicator')).toBeDisabled();
  await expect(page.locator('#first-indicator')).toHaveValue('m2');
  await expect(page.locator('#first-indicator option')).toHaveCount(1);
  await activateTab(page,'data');
  await expect(page.locator('#indicators-table tbody tr').first()).toContainText('Рублёвая масса М2');
  await expect(page.locator('#comparison-table tbody tr')).toHaveCount(6);
  await page.click('#demo-button');
  const downloadPromise=page.waitForEvent('download');await page.click('#template-button');const download=await downloadPromise;
  const file=testInfo.outputPath('template.xlsx');await download.saveAs(file);
  await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('#data-badge')).toHaveText('Ваш Excel');
  await expect(page.locator('#current-title')).toHaveText('Марковиц');
  await expect(page.locator('#message')).not.toHaveClass(/error/);
  await activateTab(page,'comparison');
  const exportPromise=page.waitForEvent('download');await page.click('#export-button');const exported=await exportPromise;
  const output=testInfo.outputPath('results.xlsx');await exported.saveAs(output);const workbook=XLSX.read(await readFile(output),{type:'buffer'});
  expect(workbook.SheetNames).toEqual(['Показатели','Веса','Реальный капитал','Просадки','Эффективная граница','Исходные данные','Реальные доходности','Методика']);
  const weights=XLSX.utils.sheet_to_json(workbook.Sheets['Веса'],{header:1}).slice(1).reduce((s,r)=>s+r[1],0);expect(weights).toBeCloseTo(1,8);
  const bad=XLSX.utils.book_new();XLSX.utils.book_append_sheet(bad,XLSX.utils.aoa_to_sheet([['Дата','ИПЦ'],['2020-01-31',100]]),'Данные');
  await activateTab(page,'data');
  await page.locator('#file-input').setInputFiles({name:'bad.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(XLSX.write(bad,{type:'buffer',bookType:'xlsx'}))});
  await expect(page.locator('#message')).toHaveClass(/error/);await expect(page.locator('#indicators-table tbody tr')).toHaveCount(10);
  await page.click('#method-button');await expect(page.locator('#method-dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('#method-dialog')).toBeHidden();
  expect(errors).toEqual([]);
});

test('mobile tabs, individual report drawings and controls fit the viewport',async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/');
  await expect(page.locator('#expected-income')).not.toHaveText('—');
  await page.screenshot({path:testInfo.outputPath('mobile.png'),fullPage:true});
  await expectNoOverflow(page);
  await page.click('#save-button');await expect(page.locator('#comparison-table tbody tr')).toHaveCount(3);
  for(const tab of ['graphs','data','comparison','backtest','portfolio']) {
    await activateTab(page,tab);
    await expectNoOverflow(page);
    if(tab==='graphs') {
      for(const id of reportCharts)await expect(page.locator('#'+id+' svg')).toBeVisible();
      expect(await chartCounts(page,individualCharts)).toEqual([2,1,1,1,1,1]);
      expect(await chartCounts(page,['report-comparison-chart'])).toEqual([3]);
      await page.screenshot({path:testInfo.outputPath('mobile-graphs.png'),fullPage:true});
    }
  }
});

test('current charts stay separate, the final report compares portfolios and all drawings export SVG',async({page},testInfo)=>{
  test.setTimeout(45000);
  await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();
  await expect(page.locator('[data-view="return"]')).toHaveClass('active');
  const initial=await page.evaluate(()=>{
    const get=id=>echarts.getInstanceByDom(document.getElementById(id)).getOption();
    return {frontier:get('frontier-chart').series[0].data,curve:get('equity-chart').series[0].data,pie:get('weights-chart').series[0].data};
  });
  expect(initial.frontier).toHaveLength(65);expect(initial.curve).toHaveLength(85);expect(initial.curve[0]).toBe(0);
  expect(initial.frontier.every(p=>p.length===2&&p.every(Number.isFinite))).toBeTruthy();
  expect(initial.pie.reduce((s,p)=>s+p.value,0)).toBeCloseTo(100,6);
  expect(await chartCounts(page,primaryCharts)).toEqual([2,1,1]);
  const hovered=await page.evaluate(()=>{const c=echarts.getInstanceByDom(document.getElementById('weights-chart'));c.dispatchAction({type:'showTip',seriesIndex:0,dataIndex:0});return c.getOption().series[0].data[0].name;});
  await expect(page.locator('#weights-chart')).toContainText(hovered);
  await page.click('#save-button');
  expect(await chartCounts(page,primaryCharts)).toEqual([2,1,1]);
  await activateTab(page,'graphs');
  await expect(page.locator('#report-portfolio option')).toHaveCount(3);
  expect(await chartCounts(page,individualCharts)).toEqual([2,1,1,1,1,1]);
  const report=await chartSeries(page,individualCharts);
  expect(report[0][0].data).toEqual(initial.frontier);
  expect(report[1][0].data).toEqual(initial.curve);
  expect(report[2][0].data.map(p=>p.value)).toEqual(initial.pie.map(p=>p.value));
  const selected=await page.locator('#report-portfolio option').nth(1).getAttribute('value');
  await page.selectOption('#report-portfolio',selected);
  expect(await chartCounts(page,individualCharts)).toEqual([2,1,1,1,1,1]);
  const selectedReport=(await chartSeries(page,individualCharts)).map(series=>series.map(s=>s.data));
  const finalPosition=await page.evaluate(()=>{
    const bottom=document.getElementById('report-comparison-chart').getBoundingClientRect();
    return ['report-frontier-chart','report-return-chart','report-weights-chart','report-capital-chart','report-drawdown-chart','report-recovery-chart'].every(id=>document.getElementById(id).getBoundingClientRect().bottom<=bottom.top);
  });
  expect(finalPosition).toBeTruthy();
  for(const mode of ['return','wealth','drawdown','recovery','frontier','weights']) {
    await page.selectOption('#report-comparison-view',mode);
    expect(await chartCounts(page,['report-comparison-chart'])).toEqual([mode==='frontier'?4:3]);
    expect((await chartSeries(page,individualCharts)).map(series=>series.map(s=>s.data))).toEqual(selectedReport);
  }
  await page.selectOption('#report-comparison-view','return');
  await activateTab(page,'comparison');
  await page.locator('[data-toggle]').first().uncheck();
  await activateTab(page,'graphs');
  expect(await chartCounts(page,['report-comparison-chart'])).toEqual([2]);
  expect((await chartSeries(page,individualCharts)).map(series=>series.map(s=>s.data))).toEqual(selectedReport);
  await activateTab(page,'portfolio');
  expect(await chartCounts(page,primaryCharts)).toEqual([2,1,1]);
  expect((await chartSeries(page,['equity-chart']))[0][0].data).toEqual(initial.curve);
  await activateTab(page,'comparison');await page.locator('[data-toggle]').first().check();
  await activateTab(page,'portfolio');
  for(const id of primaryCharts)await downloadSvg(page,testInfo,id);
  await activateTab(page,'graphs');
  for(const id of reportCharts)await downloadSvg(page,testInfo,id);
});

test('known imported path matches all separate graphs, income, volatility, drawdown and recovery metrics',async({page},testInfo)=>{
  const levels=[100,80,100,90,81,81,81,81,81,81,81,81,81];
  const dates=levels.map((_,i)=>new Date(Date.UTC(2020,i+1,0)).toISOString().slice(0,10));
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Дата','ИПЦ',...Array.from({length:10},(_,i)=>'Индикатор '+(i+1))],...levels.map((v,i)=>[dates[i],100,...Array(10).fill(v)])]),'Данные');
  await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();
  await activateTab(page,'data');
  await page.locator('#file-input').setInputFiles({name:'known.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(XLSX.write(book,{type:'buffer',bookType:'xlsx'}))});
  await expect(page.locator('#data-badge')).toHaveText('Ваш Excel');await expect(page.locator('#message')).not.toHaveClass(/error/);
  await activateTab(page,'portfolio');
  await expect(page.locator('#expected-income')).toHaveText('-150\u00a0000 ₽');
  await expect(page.locator('#drawdown-value')).toHaveText('-20,00\u00a0%');
  await expect(page.locator('#recovery-value')).toHaveText('≥ 306 дн.');
  const graph=(await chartSeries(page,['equity-chart']))[0][0].data;
  graph.forEach((v,i)=>expect(v).toBeCloseTo(levels[i]-100,6));
  await page.locator('[data-view="wealth"]').click();
  const capital=(await chartSeries(page,['equity-chart']))[0][0].data;
  capital.forEach((v,i)=>expect(v).toBeCloseTo(levels[i]*10000,5));
  await page.locator('[data-view="drawdown"]').click();
  const drawdown=(await chartSeries(page,['equity-chart']))[0][0].data;
  expect(Math.min(...drawdown)).toBeCloseTo(-20,6);
  await activateTab(page,'graphs');
  await expect(page.locator('#report-income')).toHaveText('-150\u00a0000 ₽');
  await expect(page.locator('#report-risk')).toHaveText(await page.locator('#risk-value').textContent());
  await expect(page.locator('#report-drawdown')).toHaveText('-20,00\u00a0%');
  await expect(page.locator('#report-recovery')).toHaveText('≥ 306 дн.');
  const report=await chartSeries(page,individualCharts);
  report[1][0].data.forEach((v,i)=>expect(v).toBeCloseTo(levels[i]-100,6));
  report[3][0].data.forEach((v,i)=>expect(v).toBeCloseTo(levels[i]*10000,5));
  expect(report[4][0].data).toEqual(drawdown);
  expect(report[5][0].data).toEqual([0,29,0,30,61,91,122,153,183,214,244,275,306]);
  expect(report[2][0].data.reduce((s,p)=>s+p.value,0)).toBeCloseTo(100,6);
  await activateTab(page,'comparison');
  const downloading=page.waitForEvent('download');await page.click('#export-button');const download=await downloading;
  const file=testInfo.outputPath('known-results.xlsx');await download.saveAs(file);
  const result=XLSX.read(await readFile(file),{type:'buffer'}),[headers,row]=XLSX.utils.sheet_to_json(result.Sheets['Показатели'],{header:1});
  const s=Object.fromEntries(headers.map((h,i)=>[h,row[i]]));
  expect(s['Ожидаемая доходность / год']).toBeCloseTo(-.15,8);
  expect(s['Ожидаемый реальный доход, ₽']).toBeCloseTo(-150000,6);
  expect(s['Волатильность / год']).toBeCloseTo(Math.sqrt((.1225-12*.0125**2)/11*12),8);
  expect(s['CAGR']).toBeCloseTo(-.19,8);expect(s['Макс. просадка']).toBeCloseTo(-.2,8);
  expect(s['Макс. период восстановления, дни']).toBe(306);expect(s['Максимальное восстановление незавершено']).toBe('Да');
});

test('invalid hidden controls do not block other criteria and hidden charts resize after tab activation',async({page})=>{
  await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();
  await page.selectOption('#mode','return');await page.fill('#target-risk','-5');
  await page.selectOption('#mode','markowitz');await expect(page.locator('#target-risk')).toBeDisabled();
  await page.fill('#lambda','4');await page.click('#calculate-button');await expect(page.locator('#current-title')).toHaveText('Марковиц');
  await page.click('#save-button');
  await activateTab(page,'graphs');
  const selected=await page.locator('#report-portfolio option').nth(1).getAttribute('value');
  await page.selectOption('#report-portfolio',selected);
  await activateTab(page,'data');
  await page.setViewportSize({width:390,height:844});
  await activateTab(page,'graphs');
  await expect.poll(()=>page.evaluate(ids=>ids.every(id=>{const element=document.getElementById(id),chart=echarts.getInstanceByDom(element);return element.clientWidth>200&&chart.getWidth()===element.clientWidth&&chart.getHeight()===element.clientHeight;}),reportCharts)).toBeTruthy();
  await expectNoOverflow(page);
  await activateTab(page,'comparison');
  await page.locator('[data-remove="'+selected+'"]').click();
  await activateTab(page,'graphs');
  await expect(page.locator('#report-portfolio')).toHaveValue('current');
  await activateTab(page,'portfolio');
  await expect.poll(()=>page.evaluate(ids=>ids.every(id=>{const element=document.getElementById(id),chart=echarts.getInstanceByDom(element);return chart.getWidth()===element.clientWidth&&chart.getHeight()===element.clientHeight;}),primaryCharts)).toBeTruthy();
  await page.click('#save-button');
  await activateTab(page,'comparison');
  const colorValues=await page.locator('.portfolio-chip .swatch').evaluateAll(els=>els.map(el=>el.style.background));
  expect(new Set(colorValues).size).toBe(colorValues.length);
});

test('language and theme switching preserve tab, report selection, portfolio data and translated charts',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();
  await page.selectOption('#mode','markowitz');await page.fill('#lambda','4');await page.click('#calculate-button');
  await expect(page.locator('#current-title')).toHaveText('Марковиц');await page.click('#save-button');
  await page.locator('[data-view="drawdown"]').click();
  await activateTab(page,'comparison');await page.locator('[data-toggle]').first().uncheck();
  await activateTab(page,'graphs');
  const selected=await page.locator('#report-portfolio option').nth(2).getAttribute('value');
  await page.selectOption('#report-portfolio',selected);
  await page.selectOption('#report-comparison-view','drawdown');
  const ids=[...primaryCharts,...reportCharts];
  const series=async()=>(await chartSeries(page,ids)).map(series=>series.map(s=>s.type==='pie'?s.data.map(p=>p.value):s.data));
  const before=await series();
  await page.click('#language-button');
  await expect(page.locator('html')).toHaveAttribute('lang','en');
  await expect(page.locator('#calculate-button')).toHaveText('Calculate portfolio');
  await expect(page.locator('#current-title')).toHaveText('Markowitz');
  await expect(page.locator('#message')).toContainText('Portfolio “Markowitz');
  await expect(page.locator('#comparison-table tbody tr')).toHaveCount(3);
  await expect(page.locator('[data-toggle]').first()).not.toBeChecked();
  await expect(page.locator('[data-view="drawdown"]')).toHaveClass('active');
  await expect(page.locator('#lambda')).toHaveValue('4');
  await expect(page.locator('#panel-graphs')).toBeVisible();
  await expect(page.locator('#report-portfolio')).toHaveValue(selected);
  await expect(page.locator('#report-comparison-view')).toHaveValue('drawdown');
  expect(await page.evaluate(()=>document.body.innerText.match(/[А-Яа-яЁё]+/g))).toBeNull();
  const english=await series();expect(english).toEqual(before);
  await page.click('#theme-button');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await expect(page.locator('#theme-button')).toHaveText('☀ Light theme');
  await expect(page.locator('#theme-button')).toHaveAttribute('aria-pressed','true');
  expect(await series()).toEqual(english);
  const backgrounds=await page.evaluate(ids=>({surface:getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),charts:ids.map(id=>echarts.getInstanceByDom(document.getElementById(id)).getOption().backgroundColor)}),reportCharts);
  expect(backgrounds.charts).toEqual(reportCharts.map(()=>backgrounds.surface));
  await page.click('#method-button');await expect(page.locator('#method-dialog')).toBeVisible();
  expect(await page.locator('#method-dialog').innerText()).not.toMatch(/[А-Яа-яЁё]/);
  await page.screenshot({path:testInfo.outputPath('english-dark-method.png'),fullPage:true});
  await page.click('#close-method');
  await activateTab(page,'portfolio');
  expect(await page.evaluate(ids=>ids.map(id=>echarts.getInstanceByDom(document.getElementById(id)).getOption().backgroundColor),primaryCharts)).toEqual(primaryCharts.map(()=>backgrounds.surface));
  expect(await series()).toEqual(english);
  const {download,svg}=await downloadSvg(page,testInfo,'frontier-chart');
  expect(download.suggestedFilename()).toBe('Efficient_frontier.svg');
  expect(svg).toContain('Risk, % / year');expect(svg).toContain('Return, % / year');expect(svg).toContain(backgrounds.surface);
  await activateTab(page,'graphs');
  const reportSvg=await downloadSvg(page,testInfo,'report-recovery-chart');
  expect(reportSvg.svg).not.toMatch(/[А-Яа-яЁё]/);
  await page.setViewportSize({width:390,height:844});
  await expectNoOverflow(page);
  await page.screenshot({path:testInfo.outputPath('english-dark-mobile.png'),fullPage:true});
  await page.reload();await expect(page.locator('#report-return-chart svg')).toBeVisible();
  await expect(page.locator('#panel-graphs')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang','en');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.click('#language-button');await page.click('#theme-button');
  await activateTab(page,'portfolio');
  await expect(page.locator('html')).toHaveAttribute('lang','ru');await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await expect(page.locator('#calculate-button')).toHaveText('Рассчитать портфель');
  await expect(page.locator('#current-title')).toHaveText('Максимум Шарпа');
  expect(errors).toEqual([]);
});

test('English Excel roundtrip, uploaded names and translated validation errors work in the data tab',async({page},testInfo)=>{
  await page.goto('/');await page.click('#language-button');await activateTab(page,'data');
  const waiting=page.waitForEvent('download');await page.click('#template-button');const download=await waiting;
  expect(download.suggestedFilename()).toBe('Template_10_indicators.xlsx');
  const file=testInfo.outputPath('english-template.xlsx');await download.saveAs(file);
  const book=XLSX.read(await readFile(file),{type:'buffer'});
  expect(book.SheetNames).toEqual(['Data','Instructions']);
  const rows=XLSX.utils.sheet_to_json(book.Sheets.Data,{header:1});
  expect(rows[0].slice(0,3)).toEqual(['Date','CPI','Ruble money supply M2']);
  rows[0][3]='Мой индикатор';book.Sheets.Data=XLSX.utils.aoa_to_sheet(rows);
  await page.locator('#file-input').setInputFiles({name:'custom.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(XLSX.write(book,{type:'buffer',bookType:'xlsx'}))});
  await expect(page.locator('#data-badge')).toHaveText('Your Excel');await expect(page.locator('#message')).not.toHaveClass(/error/);
  await expect(page.locator('#indicators-table')).toContainText('Мой индикатор');
  await page.click('#language-button');await expect(page.locator('#indicators-table')).toContainText('Мой индикатор');
  await page.click('#language-button');
  await activateTab(page,'comparison');
  const exporting=page.waitForEvent('download');await page.click('#export-button');const exported=await exporting;
  const output=testInfo.outputPath('english-results.xlsx');await exported.saveAs(output);
  const result=XLSX.read(await readFile(output),{type:'buffer'});
  expect(result.SheetNames).toEqual(['Metrics','Weights','Real capital','Drawdowns','Efficient frontier','Source data','Real returns','Methodology']);
  const summary=XLSX.utils.sheet_to_json(result.Sheets.Metrics,{header:1});
  expect(summary[0][0]).toBe('Portfolio');expect(summary[1][0]).toBe('Markowitz');
  expect(XLSX.utils.sheet_to_json(result.Sheets.Weights,{header:1})[2][0]).toBe('Мой индикатор');
  await activateTab(page,'data');
  const bad=XLSX.utils.book_new();XLSX.utils.book_append_sheet(bad,XLSX.utils.aoa_to_sheet([['Date','CPI'],['2020-01-31',100]]),'Data');
  await page.locator('#file-input').setInputFiles({name:'bad.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(XLSX.write(bad,{type:'buffer',bookType:'xlsx'}))});
  await expect(page.locator('#message')).toHaveClass(/error/);await expect(page.locator('#message')).toContainText('At least 13');
  await page.click('#language-button');await expect(page.locator('#message')).toContainText('Нужно минимум 13');
});

test('Excel upload supports keyboard and file drop while preserving data on invalid files',async({page})=>{
  await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();await activateTab(page,'data');
  const frame=page.locator('#upload-frame');
  for(const key of ['Enter','Space']) {
    await frame.focus();
    const chooserPromise=page.waitForEvent('filechooser');
    await frame.press(key);
    await (await chooserPromise).setFiles([]);
  }
  const invalid=await page.evaluateHandle(()=>{const dt=new DataTransfer();dt.items.add(new File(['invalid'],'prices.csv',{type:'text/csv'}));return dt;});
  await frame.dispatchEvent('dragenter',{dataTransfer:invalid});
  await expect(frame).toHaveClass(/dragging/);
  await frame.dispatchEvent('drop',{dataTransfer:invalid});
  await expect(frame).not.toHaveClass(/dragging/);
  await expect(page.locator('#message')).toHaveClass(/error/);
  await expect(page.locator('#message')).toContainText('Выберите файл .xlsx или .xls.');
  await expect(page.locator('#data-status')).toHaveText('Учебные данные');
  await expect(page.locator('#indicators-table tbody tr')).toHaveCount(10);
  await invalid.dispose();
  const book=XLSX.utils.book_new();
  const names=['Рублёвая масса М2',...Array.from({length:9},(_,i)=>'Индикатор '+(i+2))];
  const rows=Array.from({length:13},(_,i)=>[new Date(Date.UTC(2020,i+1,0)).toISOString().slice(0,10),100,...Array(10).fill(100+i)]);
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Дата','ИПЦ',...names],...rows]),'Данные');
  const bytes=Array.from(XLSX.write(book,{type:'buffer',bookType:'xlsx'}));
  const transfer=await page.evaluateHandle(data=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(data)],'dropped.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));return dt;},bytes);
  await frame.dispatchEvent('dragenter',{dataTransfer:transfer});
  await frame.dispatchEvent('dragover',{dataTransfer:transfer});
  await frame.dispatchEvent('drop',{dataTransfer:transfer});
  await expect(frame).not.toHaveClass(/dragging/);
  await expect(page.locator('#data-status')).toHaveText('Ваш Excel');
  await expect(page.locator('#data-badge')).toHaveText('Ваш Excel');
  await expect(page.locator('#upload-status')).toHaveText('dropped.xlsx');
  await expect(page.locator('#current-title')).toHaveText('Марковиц');
  await expect(page.locator('#message')).not.toHaveClass(/error/);
  await activateTab(page,'portfolio');
  expect((await chartSeries(page,['equity-chart']))[0][0].data).toHaveLength(13);
  await transfer.dispose();
  await activateTab(page,'data');
  await page.click('#demo-button');
  await expect(page.locator('#data-status')).toHaveText('Учебные данные');
  await expect(page.locator('#upload-status')).toHaveText('Перетащите Excel сюда');
});

test('tabs support arrow keys, Home and End with one active accessible panel',async({page})=>{
  await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(5);
  for(const name of tabs) {
    await expect(page.locator('#tab-'+name)).toHaveAttribute('role','tab');
    await expect(page.locator('#tab-'+name)).toHaveAttribute('aria-controls','panel-'+name);
    await expect(page.locator('#panel-'+name)).toHaveAttribute('role','tabpanel');
    await expect(page.locator('#panel-'+name)).toHaveAttribute('aria-labelledby','tab-'+name);
  }
  await page.locator('#tab-portfolio').focus();
  const steps=[['ArrowRight','graphs'],['ArrowRight','comparison'],['ArrowRight','backtest'],['ArrowRight','data'],['ArrowRight','portfolio'],['ArrowLeft','data'],['Home','portfolio'],['End','data']];
  for(const [key,active] of steps) {
    await page.keyboard.press(key);
    await expect(page.locator('#tab-'+active)).toBeFocused();
    for(const name of tabs) {
      await expect(page.locator('#tab-'+name)).toHaveAttribute('aria-selected',String(name===active));
      await expect(page.locator('#tab-'+name)).toHaveAttribute('tabindex',name===active?'0':'-1');
      if(name===active)await expect(page.locator('#panel-'+name)).toBeVisible();
      else await expect(page.locator('#panel-'+name)).toBeHidden();
    }
  }
});
