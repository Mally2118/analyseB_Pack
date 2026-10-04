import {test,expect} from '@playwright/test';
import XLSX from 'xlsx';
import {readFile} from 'node:fs/promises';
test('four criteria, chart comparison, errors and Excel roundtrip',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#current-title')).toHaveText('Максимум Шарпа');
  await expect(page.locator('#indicators-table tbody tr')).toHaveCount(10);
  await expect(page.locator('#comparison-table tbody tr')).toHaveCount(2);
  await expect(page.locator('#equity-chart svg')).toBeVisible();
  await expect(page.locator('#message')).toBeHidden();
  await page.screenshot({path:testInfo.outputPath('desktop.png'),fullPage:true});
  for(const mode of ['markowitz','sharpe','risk','return']) {
    await page.selectOption('#mode',mode);
    await page.click('#calculate-button');
    await expect(page.locator('#calculate-button')).toBeEnabled();
    await expect(page.locator('#current-title')).toHaveText({markowitz:'Марковиц',sharpe:'Максимум Шарпа',risk:'Эффективный риск',return:'Эффективная доходность'}[mode]);
    await expect(page.locator('#message')).not.toHaveClass(/error/);
    await page.click('#save-button');
  }
  await expect(page.locator('#comparison-table tbody tr')).toHaveCount(6);
  await page.selectOption('#weights-view','compare');
  await expect(page.locator('#weights-chart svg')).toBeVisible();
  await page.locator('[data-view="drawdown"]').click();
  await expect(page.locator('[data-view="drawdown"]')).toHaveClass('active');
  const previous=await page.locator('#risk-value').textContent();
  await page.selectOption('#mode','return');await page.fill('#target-risk','0');await page.click('#calculate-button');
  await expect(page.locator('#message')).toHaveClass(/error/);
  await expect(page.locator('#risk-value')).toHaveText(previous);
  await page.selectOption('#mode','markowitz');
  await page.selectOption('#first-indicator','cash');await page.click('#calculate-button');
  await expect(page.locator('#comparison-cards .portfolio-chip')).toHaveCount(0);
  await expect(page.locator('#indicators-table')).toContainText('Рублёвый остаток');
  await page.click('#demo-button');
  const downloadPromise=page.waitForEvent('download');await page.click('#template-button');const download=await downloadPromise;
  const file=testInfo.outputPath('template.xlsx');await download.saveAs(file);
  await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('#data-badge')).toHaveText('Ваш Excel');
  await expect(page.locator('#current-title')).toHaveText('Марковиц');
  await expect(page.locator('#message')).not.toHaveClass(/error/);
  const exportPromise=page.waitForEvent('download');await page.click('#export-button');const exported=await exportPromise;
  const output=testInfo.outputPath('results.xlsx');await exported.saveAs(output);const workbook=XLSX.read(await readFile(output),{type:'buffer'});
  expect(workbook.SheetNames).toEqual(['Показатели','Веса','Реальный капитал','Просадки','Эффективная граница','Исходные данные','Реальные доходности','Методика']);
  const weights=XLSX.utils.sheet_to_json(workbook.Sheets['Веса'],{header:1}).slice(1).reduce((s,r)=>s+r[1],0);expect(weights).toBeCloseTo(1,8);
  const bad=XLSX.utils.book_new();XLSX.utils.book_append_sheet(bad,XLSX.utils.aoa_to_sheet([['Дата','ИПЦ'],['2020-01-31',100]]),'Данные');
  await page.locator('#file-input').setInputFiles({name:'bad.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(XLSX.write(bad,{type:'buffer',bookType:'xlsx'}))});
  await expect(page.locator('#message')).toHaveClass(/error/);await expect(page.locator('#indicators-table tbody tr')).toHaveCount(10);
  await page.click('#method-button');await expect(page.locator('#method-dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('#method-dialog')).toBeHidden();
  expect(errors).toEqual([]);
});
test('mobile charts and controls fit the viewport',async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/');
  await expect(page.locator('#expected-income')).not.toHaveText('—');
  await page.selectOption('#weights-view','compare');
  await page.screenshot({path:testInfo.outputPath('mobile.png'),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.click('#save-button');await expect(page.locator('#comparison-table tbody tr')).toHaveCount(3);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});

test('charts contain real data, show weights interactively and export all three SVG drawings',async({page},testInfo)=>{
  await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();
  await expect(page.locator('[data-view="return"]')).toHaveClass('active');
  const initial=await page.evaluate(()=>{
    const get=id=>echarts.getInstanceByDom(document.getElementById(id)).getOption();
    return {frontier:get('frontier-chart').series[0].data,curve:get('equity-chart').series[0].data,pie:get('weights-chart').series[0].data};
  });
  expect(initial.frontier).toHaveLength(65);expect(initial.curve).toHaveLength(85);expect(initial.curve[0]).toBe(0);
  expect(initial.frontier.every(p=>p.length===2&&p.every(Number.isFinite))).toBeTruthy();
  expect(initial.pie.reduce((s,p)=>s+p.value,0)).toBeCloseTo(100,6);
  const hovered=await page.evaluate(()=>{const c=echarts.getInstanceByDom(document.getElementById('weights-chart'));c.dispatchAction({type:'showTip',seriesIndex:0,dataIndex:0});return c.getOption().series[0].data[0].name;});
  await expect(page.locator('#weights-chart')).toContainText(hovered);
  await page.click('#save-button');
  await page.selectOption('#weights-view','compare');
  const before=await page.evaluate(()=>['frontier-chart','equity-chart','weights-chart'].map(id=>echarts.getInstanceByDom(document.getElementById(id)).getOption().series.length));
  expect(before).toEqual([4,3,3]);
  await page.locator('[data-toggle]').first().uncheck();
  const after=await page.evaluate(()=>['frontier-chart','equity-chart','weights-chart'].map(id=>echarts.getInstanceByDom(document.getElementById(id)).getOption().series.length));
  expect(after).toEqual([3,2,2]);
  await page.locator('[data-toggle]').first().check();
  for(const id of ['frontier-chart','equity-chart','weights-chart']) {
    const downloading=page.waitForEvent('download',{timeout:10000});
    await page.locator('[data-download="'+id+'"]').click();
    const download=await downloading;
    expect(download.suggestedFilename()).toMatch(/\.svg$/);
    const file=testInfo.outputPath(id+'.svg');await download.saveAs(file);
    const svg=await readFile(file,'utf8');expect(svg).toContain('<svg');expect(svg).toContain('</svg>');
  }
});

test('known imported path matches graph, income, volatility, drawdown and recovery metrics',async({page},testInfo)=>{
  const levels=[100,80,100,90,81,81,81,81,81,81,81,81,81];
  const dates=levels.map((_,i)=>new Date(Date.UTC(2020,i+1,0)).toISOString().slice(0,10));
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Дата','ИПЦ',...Array.from({length:10},(_,i)=>'Индикатор '+(i+1))],...levels.map((v,i)=>[dates[i],100,...Array(10).fill(v)])]),'Данные');
  await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();
  await page.locator('#file-input').setInputFiles({name:'known.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(XLSX.write(book,{type:'buffer',bookType:'xlsx'}))});
  await expect(page.locator('#data-badge')).toHaveText('Ваш Excel');await expect(page.locator('#message')).not.toHaveClass(/error/);
  await expect(page.locator('#expected-income')).toHaveText('-150\u00a0000 ₽');
  await expect(page.locator('#drawdown-value')).toHaveText('-20,00\u00a0%');
  await expect(page.locator('#recovery-value')).toHaveText('≥ 306 дн.');
  const graph=await page.evaluate(()=>echarts.getInstanceByDom(document.getElementById('equity-chart')).getOption().series[0].data);
  graph.forEach((v,i)=>expect(v).toBeCloseTo(levels[i]-100,6));
  await page.locator('[data-view="wealth"]').click();
  const capital=await page.evaluate(()=>echarts.getInstanceByDom(document.getElementById('equity-chart')).getOption().series[0].data);
  capital.forEach((v,i)=>expect(v).toBeCloseTo(levels[i]*10000,5));
  await page.locator('[data-view="drawdown"]').click();
  const drawdown=await page.evaluate(()=>echarts.getInstanceByDom(document.getElementById('equity-chart')).getOption().series[0].data);
  expect(Math.min(...drawdown)).toBeCloseTo(-20,6);
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

test('invalid hidden controls do not block other criteria and compared pies reflow on resize',async({page})=>{
  await page.goto('/');await expect(page.locator('#equity-chart svg')).toBeVisible();
  await page.selectOption('#mode','return');await page.fill('#target-risk','-5');
  await page.selectOption('#mode','markowitz');await expect(page.locator('#target-risk')).toBeDisabled();
  await page.fill('#lambda','4');await page.click('#calculate-button');await expect(page.locator('#current-title')).toHaveText('Марковиц');
  await page.click('#save-button');await page.selectOption('#weights-view','compare');
  await page.setViewportSize({width:390,height:844});
  await expect.poll(()=>page.locator('#weights-chart').evaluate(el=>el.clientHeight)).toBe(690);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.locator('[data-remove]').first().click();await page.click('#save-button');
  const colorValues=await page.locator('.portfolio-chip .swatch').evaluateAll(els=>els.map(el=>el.style.background));
  expect(new Set(colorValues).size).toBe(colorValues.length);
});
