import {demoData,parseTable,estimate,createOptimizer,metrics} from './engine.js';
const $=id=>document.getElementById(id);
const percent=v=>Number.isFinite(v)?new Intl.NumberFormat('ru-RU',{style:'percent',minimumFractionDigits:2,maximumFractionDigits:2}).format(v):'—';
const number=v=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(v);
const money=v=>number(v)+' ₽';
const recoveryText=s=>(s.recoveryIncomplete?'≥ ':'')+number(s.maxRecovery)+' дн.';
const axisPercent=v=>new Intl.NumberFormat('ru-RU',{maximumSignificantDigits:3}).format(v);
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colors=['#204f40','#91ac35','#557bbe','#d5a04e','#7d68a3','#50a6a2','#b87963','#739764','#68768d','#a08b40'];
const modes={markowitz:'Марковиц',sharpe:'Максимум Шарпа',risk:'Эффективный риск',return:'Эффективная доходность'};
const descriptions={markowitz:'Максимум доходности с штрафом за риск. Чем выше λ, тем осторожнее портфель.',sharpe:'Максимум избыточной реальной доходности на единицу риска.',risk:'Минимальный риск при доходности не ниже заданного уровня.',return:'Максимальная доходность при риске не выше заданного лимита.'};
let data=demoData(),model,optimizer,current,saved=[],sequence=0,view='return',capital=1000000,rf=0,signature='',weightsColumns=0;
const charts={};
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);$('message').hidden=false;}
function modeFields(){
  const mode=$('mode').value;$('mode-description').textContent=descriptions[mode];
  for(const [id,criterion] of [['lambda','markowitz'],['target-return','risk'],['target-risk','return']]) {
    $(id+'-field').hidden=mode!==criterion;$(id).disabled=mode!==criterion;
  }
}
function numeric(id){const value=$(id).value.trim();if(!value||!Number.isFinite(Number(value)))throw Error('Заполните числовой параметр: '+$(id).labels[0].textContent);return Number(value);}
function calculate({quiet=false,initial=false}={}) {
  const newCapital=numeric('capital'),nominalRf=numeric('rf')/100;
  if(newCapital<=0||newCapital>1e15)throw Error('Начальный капитал должен быть больше нуля и не превышать 10¹⁵ ₽.');
  if(nominalRf<=-1)throw Error('Безрисковая ставка должна быть выше −100%.');
  const frequency=Number($('frequency').value),cash=$('first-indicator').value==='cash';
  const newSignature=`${frequency}:${cash}`;
  const nextModel=newSignature!==signature||!model?estimate(data,frequency,cash):model;
  const nextOptimizer=nextModel===model?optimizer:createOptimizer(nextModel);
  const nextRf=(1+nominalRf)/(1+nextModel.inflation)-1;
  const mode=$('mode').value;
  const settings={rf:nextRf,lambda:mode==='markowitz'?numeric('lambda'):3,targetReturn:mode==='risk'?numeric('target-return')/100:.1,targetRisk:mode==='return'?numeric('target-risk')/100:.2};
  const solution=nextOptimizer.solve(mode,settings);
  metrics(nextModel,solution.weights,nextRf,newCapital);
  const cleared=newSignature!==signature&&!!model;
  model=nextModel;optimizer=nextOptimizer;capital=newCapital;rf=nextRf;signature=newSignature;
  if(cleared)saved=[];
  current={...solution,id:'current',name:modes[mode],color:colors[0],mode,settings:{...settings,nominalRf},visible:true};
  if(initial) {
    saved=[{...optimizer.solve('markowitz',{lambda:3,rf}),id:'p'+(++sequence),name:'Марковиц · λ = 3',color:colors[1],mode:'markowitz',settings:{lambda:3},visible:true}];
  }
  render();
  if(!quiet)message(cleared?'Портфель рассчитан. При смене периодичности или первого индикатора сравнение очищено.':'Портфель рассчитан. Добавьте результат к сравнению, затем выберите другой критерий.');
  return {name:current.name,weights:[...current.weights],expectedReturn:current.return,risk:current.risk};
}
function allPortfolios(){return [current,...saved];}
function visiblePortfolios(){return allPortfolios().filter(p=>p.visible);}
function stat(p){return metrics(model,p.weights,rf,capital);}
function render() {
  const s=stat(current);
  $('data-badge').textContent=data.demo?'Учебные данные':'Ваш Excel';
  $('data-info').textContent=`${data.rows[0].date} — ${data.rows.at(-1).date} · ${data.rows.length} наблюдений · инфляция ${percent(model.inflation)} / год`;
  $('demo-note').textContent=data.demo?'Синтетические ряды для демонстрации расчётов. Для работы с историческими данными загрузите Excel. Цены валют и активов должны быть выражены в рублях.':'Источник: '+data.source+'. Все ряды скорректированы на ИПЦ из файла; экономическое содержание и рублёвые единицы проверьте по своим источникам.';
  $('current-title').textContent=current.name;
  $('expected-income').textContent=money(s.expectedIncome);
  $('expected-rate').textContent=percent(s.expectedReturn)+' реальной доходности / год';
  $('risk-value').textContent=percent(s.risk);
  $('drawdown-value').textContent=percent(s.maxDrawdown);
  $('recovery-value').textContent=recoveryText(s);
  $('recovery-note').textContent=s.recoveryIncomplete?'Возврат к пику ещё не произошёл':s.openRecovery?'Текущее восстановление: '+number(s.openRecovery)+' дн.':'По завершённым восстановлениям';
  $('indicators-table').querySelector('tbody').innerHTML=model.names.map((name,i)=>`<tr><td>${String(i+1).padStart(2,'0')}</td><td><span class="asset-name"><span class="swatch" style="background:${colors[i]}"></span>${escape(name)}</span></td><td>${percent(model.mu[i])}</td><td>${percent(Math.sqrt(model.cov[i][i]))}</td><td><span class="weight-cell"><strong>${percent(current.weights[i])}</strong><span class="weight-bar"><span style="width:${current.weights[i]*100}%"></span></span></span></td></tr>`).join('');
  renderComparison();renderCharts();
}
function renderComparison() {
  $('comparison-cards').innerHTML=saved.length?saved.map(p=>`<div class="portfolio-chip"><input type="checkbox" ${p.visible?'checked':''} data-toggle="${p.id}" aria-label="Показать ${escape(p.name)} на графиках"><span class="swatch" style="background:${p.color}"></span><span>${escape(p.name)}</span><button data-remove="${p.id}" aria-label="Удалить ${escape(p.name)}">×</button></div>`).join(''):'<p class="empty-note">Добавьте текущий портфель, чтобы сравнить его с результатами других критериев.</p>';
  $('comparison-table').querySelector('tbody').innerHTML=allPortfolios().map(p=>{const s=stat(p);return `<tr><td><span class="asset-name"><span class="swatch" style="background:${p.color}"></span>${escape(p.name)}${p.id==='current'?' · текущий':''}</span></td><td>${money(s.expectedIncome)}</td><td>${percent(s.expectedReturn)}</td><td>${percent(s.risk)}</td><td>${s.sharpe===null?'Не определён':s.sharpe.toFixed(2)}</td><td>${percent(s.cagr)}</td><td>${percent(s.totalReturn)}</td><td>${percent(s.maxDrawdown)}</td><td>${recoveryText(s)}</td><td>${number(s.longestRecovery)} дн.</td><td>${s.openRecovery?'≥ '+number(s.openRecovery)+' дн.':'—'}</td></tr>`;}).join('');
}
const baseChart={animation:!matchMedia('(prefers-reduced-motion: reduce)').matches,textStyle:{fontFamily:'Segoe UI, Arial, sans-serif',color:'#667672',fontSize:12},aria:{enabled:true},backgroundColor:'#fff'};
function chart(id){return charts[id]??(charts[id]=echarts.init($(id),null,{renderer:'svg'}));}
function tooltipRows(items,value){return items.map(p=>`<div style="margin:5px 0"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${p.color};margin-right:7px"></span>${escape(p.seriesName)} <b>${escape(value(p))}</b></div>`).join('');}
function renderCharts() {
  const portfolios=visiblePortfolios(),frontier=optimizer.frontier;
  chart('frontier-chart').setOption({...baseChart,grid:{left:58,right:18,top:30,bottom:56},tooltip:{trigger:'item',formatter:p=>`${escape(p.seriesName)}<br>Риск: <b>${percent(p.value[0]/100)}</b><br>Доходность: <b>${percent(p.value[1]/100)}</b>`},xAxis:{type:'value',name:'Риск, % / год',nameLocation:'middle',nameGap:34,axisLabel:{formatter:axisPercent},splitLine:{lineStyle:{color:'#eef2ef'}}},yAxis:{type:'value',name:'Доходность, % / год',axisLabel:{formatter:axisPercent},splitLine:{lineStyle:{color:'#eef2ef'}}},series:[{name:'Эффективная граница',type:'line',data:frontier.map(p=>[p.risk*100,p.return*100]),symbol:'none',lineStyle:{color:'#427054',width:3},z:1},...portfolios.map(p=>({name:p.name,type:'scatter',data:[[p.risk*100,p.return*100]],symbolSize:p.id==='current'?15:12,itemStyle:{color:p.color,borderColor:'#fff',borderWidth:2},z:3}))]},true);
  renderWeights();
  const useMoney=view==='wealth';
  chart('equity-chart').setOption({...baseChart,color:portfolios.map(p=>p.color),legend:{top:0,type:'scroll',textStyle:{fontSize:12},itemWidth:16,itemHeight:3},tooltip:{trigger:'axis',formatter:items=>escape(items[0]?.axisValue??'')+tooltipRows(items,p=>useMoney?money(p.value):percent(p.value/100))},grid:{left:useMoney?90:60,right:25,top:50,bottom:55},xAxis:{type:'category',boundaryGap:false,data:model.dates,axisLabel:{formatter:s=>s.slice(0,7),hideOverlap:true},axisLine:{lineStyle:{color:'#dce4dd'}}},yAxis:{type:'value',scale:view==='wealth',axisLabel:{formatter:v=>useMoney?number(v/1000)+' тыс.':axisPercent(v)+'%'},splitLine:{lineStyle:{color:'#edf2ee'}}},dataZoom:[{type:'inside'},{type:'slider',height:15,bottom:5,borderColor:'#e5ebe6',fillerColor:'#d8e5da',handleSize:14}],series:portfolios.map(p=>{const s=stat(p);return {name:p.name,type:'line',data:view==='wealth'?s.wealth.map(v=>v*capital):view==='return'?s.wealth.map(v=>(v-1)*100):s.drawdown.map(v=>v*100),symbol:'none',lineStyle:{width:p.id==='current'?3:2},emphasis:{focus:'series'}};})},true);
}
function renderWeights() {
  const ps=$('weights-view').value==='compare'?visiblePortfolios():[current];
  const cols=Math.min(3,ps.length,Math.max(1,Math.floor($('weights-chart').clientWidth/190))),rows=Math.ceil(ps.length/cols),height=ps.length===1?290:rows*230;
  weightsColumns=cols;
  $('weights-chart').style.height=height+'px';
  const titles=ps.length>1?ps.map((p,i)=>({text:p.name,left:(i%cols+.5)*100/cols+'%',top:Math.floor(i/cols)*230+8,textAlign:'center',textStyle:{fontSize:12,fontWeight:500,width:180,overflow:'truncate',color:p.color}})):[];
  chart('weights-chart').resize();
  chart('weights-chart').setOption({...baseChart,color:colors,title:titles,tooltip:{trigger:'item',formatter:p=>`${escape(p.seriesName)}<br>${escape(p.name)}: <b>${percent(p.value/100)}</b>`},legend:ps.length===1?{type:'scroll',bottom:0,textStyle:{fontSize:12},itemWidth:9,itemHeight:9}:undefined,graphic:ps.length===1?[{type:'text',left:'center',top:'43%',style:{text:'100%',fontSize:28,fontWeight:600,fill:'#183d34'}},{type:'text',left:'center',top:'55%',style:{text:'капитала',fontSize:12,fill:'#718078'}}]:[],series:ps.map((p,i)=>({name:p.name,type:'pie',radius:ps.length===1?['47%','71%']:[42,70],center:ps.length===1?['50%','46%']:[(i%cols+.5)*100/cols+'%',Math.floor(i/cols)*230+112],itemStyle:{borderColor:'#fff',borderWidth:3,borderRadius:3},label:{show:false},emphasis:{scale:true,label:{show:ps.length>1,position:'center',formatter:'{b}\n{d}%',fontSize:12}},data:model.names.map((name,j)=>({name,value:p.weights[j]*100,itemStyle:{color:colors[j]}})).filter(x=>x.value>1e-7)}))},true);
}
function savePortfolio() {
  if(saved.length>=8)throw Error('Можно сравнивать до 8 сохранённых портфелей. Удалите один, чтобы добавить новый.');
  const id='p'+(++sequence),suffix=current.mode==='markowitz'?' · λ = '+current.settings.lambda:current.mode==='risk'?' · цель '+percent(current.settings.targetReturn):current.mode==='return'?' · риск ≤ '+percent(current.settings.targetRisk):'';
  const name=current.name+suffix+' #'+sequence;
  const color=colors.slice(1).find(color=>!saved.some(p=>p.color===color));
  saved.push({...current,id,name,color,weights:[...current.weights],visible:true});
  renderComparison();renderCharts();message('Портфель «'+name+'» добавлен. Выберите другой критерий и рассчитайте следующий.');
  return {id,name};
}
function workbookDownload(book,name){XLSX.writeFile(book,name,{compression:true});}
function exportChart(id) {
  const names={'frontier-chart':'Эффективная_граница','weights-chart':'Веса_портфелей','equity-chart':view==='wealth'?'Капитал_портфелей':view==='return'?'Доходность_портфелей':'Просадки_портфелей'};
  if(!charts[id]||!names[id])throw Error('Сначала рассчитайте портфель.');
  const link=document.createElement('a');
  link.href=charts[id].getDataURL({type:'svg'});link.download=names[id]+'.svg';
  document.body.append(link);link.click();link.remove();
  message('Рисунок сохранён в SVG. Его можно вставить в отчёт или презентацию.');
}
function template() {
  const d=demoData(),book=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Дата','ИПЦ',...d.names],...d.rows.map(r=>[r.date,Number(r.cpi.toFixed(6)),...r.values.map(v=>Number(v.toFixed(6)))])]),'Данные');
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Памятка'],['Это синтетические данные, а не исторические котировки. Замените их своими рядами.'],['Первый лист: Дата, ИПЦ и ровно 10 индикаторов. Уровни положительны; даты строго возрастают.'],['ИПЦ — накопленный индекс цен (например 100, 100.5), не месячный процент инфляции.'],['Одна строка на конец каждого месяца; минимум 13 строк. Можно выбрать дневную или годовую частоту в приложении.'],['Все котировки и цены активов предварительно переведите в рубли. Для выплат используйте полную доходность.'],['Индикатор 1 — рублёвая масса М2. Его вес имеет учебную интерпретацию.'],['Введите реальные источники, единицы и описание выборки для вашей работы.']]),'Инструкция');
  workbookDownload(book,'Шаблон_10_индикаторов.xlsx');message('Excel-шаблон скачан. На первом листе замените учебные уровни своими данными.');
}
async function upload(file) {
  if(!file)return;
  if(!/\.(xlsx|xls)$/i.test(file.name))throw Error('Выберите файл .xlsx или .xls.');
  if(file.size>10*1024*1024)throw Error('Файл должен быть не больше 10 МБ.');
  const book=XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:true});
  if(!book.SheetNames.length)throw Error('В файле нет листов.');
  const next=parseTable(XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,defval:null,raw:true}));
  estimate(next,Number($('frequency').value),$('first-indicator').value==='cash');
  // Stage the replacement so a failed optimization cannot corrupt the previous results.
  const old={data,model,optimizer,current,saved,signature,capital,rf},oldMode=$('mode').value,oldLambda=$('lambda').value;
  try {data={...next,source:file.name};signature='';model=null;saved=[];$('mode').value='markowitz';$('lambda').value='3';modeFields();calculate({quiet:true});}
  catch(error){({data,model,optimizer,current,saved,signature,capital,rf}=old);$('mode').value=oldMode;$('lambda').value=oldLambda;modeFields();throw error;}
  message('Excel загружен: '+next.rows.length+' наблюдений, 10 индикаторов. Сравнение очищено; начальный расчёт выполнен по Марковицу с λ = 3.');
}
function exportResults() {
  const book=XLSX.utils.book_new(),ps=allPortfolios();
  const summary=[['Портфель','Ожидаемая доходность / год','Волатильность / год','Шарп','CAGR','Историческая доходность','Макс. просадка','Макс. завершённое восстановление, дни','Текущее восстановление, дни','Ожидаемый реальный доход, ₽','Макс. период восстановления, дни','Максимальное восстановление незавершено']];
  ps.forEach(p=>{const s=stat(p);summary.push([p.name,s.expectedReturn,s.risk,s.sharpe,s.cagr,s.totalReturn,s.maxDrawdown,s.longestRecovery,s.openRecovery,s.expectedIncome,s.maxRecovery,s.recoveryIncomplete?'Да':'Нет']);});
  const add=(rows,name)=>XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),name);
  add(summary,'Показатели');add([['Индикатор',...ps.map(p=>p.name)],...model.names.map((n,i)=>[n,...ps.map(p=>p.weights[i])])],'Веса');
  const stats=ps.map(stat);
  add([['Дата',...ps.map(p=>p.name)],...model.dates.map((date,i)=>[date,...stats.map(s=>s.wealth[i]*capital)])],'Реальный капитал');
  add([['Дата',...ps.map(p=>p.name)],...model.dates.map((date,i)=>[date,...stats.map(s=>s.drawdown[i])])],'Просадки');
  add([['Риск / год','Ожид. доходность / год',...model.names],...optimizer.frontier.map(p=>[p.risk,p.return,...p.weights])],'Эффективная граница');
  add([['Дата','ИПЦ',...data.names],...data.rows.map(r=>[r.date,r.cpi,...r.values])],'Исходные данные');
  add([['Дата',...model.names],...model.returns.map((r,i)=>[model.dates[i+1],...r])],'Реальные доходности');
  add([['Параметр','Значение'],['Источник',data.source],['Синтетические данные',data.demo?'Да':'Нет'],['Периодов в год',model.frequency],['Начальный капитал, ₽',capital],['Номинальная ставка',current.settings.nominalRf],['Реальная безрисковая ставка',rf],['Годовая инфляция',model.inflation],['Индикатор 1',model.names[0]],['Формула доходности','(P_t/P_(t-1))/(ИПЦ_t/ИПЦ_(t-1))-1'],['Ожидаемая доходность','Частота × средняя периодическая доходность'],['Ковариация','Частота × выборочная ковариация'],['Ребалансировка','Каждый период, без комиссий и налогов'],['Проверка прогноза','Кривая построена на обучающей выборке; вневыборочной проверки нет'],...ps.map(p=>['Критерий: '+p.name,JSON.stringify(p.settings)])],'Методика');
  workbookDownload(book,'Сравнение_портфелей.xlsx');message('Показатели, веса, кривые и исходные данные сохранены в Excel. Доходности в файле записаны долями: 0,1 = 10%.');
}
function guarded(action){return async(...args)=>{try{await action(...args);}catch(e){message(e.message||'Не удалось выполнить действие.',true);}};}
$('mode').addEventListener('change',modeFields);
$('optimization-form').addEventListener('submit',guarded(async e=>{e.preventDefault();$('calculate-button').disabled=true;$('save-button').disabled=true;try{await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));calculate();}finally{$('calculate-button').disabled=false;$('save-button').disabled=false;}}));
$('save-button').addEventListener('click',guarded(savePortfolio));
$('template-button').addEventListener('click',guarded(template));
$('export-button').addEventListener('click',guarded(exportResults));
document.querySelectorAll('[data-download]').forEach(button=>button.addEventListener('click',guarded(()=>exportChart(button.dataset.download))));
$('file-input').addEventListener('change',guarded(async e=>{try{await upload(e.target.files[0]);}finally{e.target.value='';}}));
$('demo-button').addEventListener('click',guarded(()=>{data=demoData();model=null;signature='';saved=[];$('frequency').value='12';$('first-indicator').value='m2';$('mode').value='sharpe';$('rf').value='8';$('capital').value='1000000';modeFields();calculate({quiet:true,initial:true});message('Учебные данные восстановлены.');}));
$('comparison-cards').addEventListener('change',e=>{const p=saved.find(p=>p.id===e.target.dataset.toggle);if(p){p.visible=e.target.checked;renderCharts();}});
$('comparison-cards').addEventListener('click',e=>{const id=e.target.dataset.remove;if(id){saved=saved.filter(p=>p.id!==id);renderComparison();renderCharts();}});
$('weights-view').addEventListener('change',renderWeights);
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{view=b.dataset.view;document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('active',x===b));renderCharts();}));
$('method-button').addEventListener('click',()=>$('method-dialog').showModal());
$('close-method').addEventListener('click',()=>$('method-dialog').close());
$('method-dialog').addEventListener('click',e=>{if(e.target===$('method-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
new ResizeObserver(()=>{
  Object.values(charts).forEach(c=>c.resize());
  if(current&&$('weights-view').value==='compare') {
    const cols=Math.min(3,visiblePortfolios().length,Math.max(1,Math.floor($('weights-chart').clientWidth/190)));
    if(cols!==weightsColumns)renderWeights();
  }
}).observe(document.querySelector('.results'));
modeFields();
try {if(!window.echarts||!window.XLSX)throw Error('Не загрузились библиотеки графиков или Excel. Перезапустите приложение.');calculate({quiet:true,initial:true});}catch(e){message(e.message,true);}
