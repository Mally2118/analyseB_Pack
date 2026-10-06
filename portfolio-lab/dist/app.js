import {demoData,parseTable,estimate,createOptimizer,metrics} from './engine.js';
import {t,locale,language,theme,setLanguage,setTheme,captureStaticTranslations,translateStatic,translateError} from './i18n.js';
import {renderReport,resizeReport,getReportChart} from './report-charts.js';
import {createBacktestView} from './backtest-ui.js';
import {createDataImportView} from './data-import-ui.js';
const $=id=>document.getElementById(id);
const percent=v=>Number.isFinite(v)?new Intl.NumberFormat(locale(),{style:'percent',minimumFractionDigits:2,maximumFractionDigits:2}).format(v):'—';
const number=v=>new Intl.NumberFormat(locale(),{maximumFractionDigits:0}).format(v);
const money=v=>number(v)+' ₽';
const recoveryText=s=>(s.recoveryIncomplete?'≥ ':'')+number(s.maxRecovery)+' '+t('дн.');
const axisPercent=v=>new Intl.NumberFormat(locale(),{maximumSignificantDigits:3}).format(v);
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const parameterLabels=new Map([...document.querySelectorAll('label[for]')].map(label=>[label.htmlFor,label.textContent]));
const lightColors=['#d9481f','#514c43','#55759b','#a68e4b','#8a719a','#5e9791','#a56855','#7f855f','#697887','#b58c6b'];
const darkColors=['#ff6a3d','#d0c5b4','#92b4df','#d8bd74','#bfa2d0','#8fc8c0','#ddad9a','#b5c18e','#a9bcca','#d7b799'];
let colors=theme==='dark'?darkColors:lightColors;
const modes={markowitz:'Марковиц',sharpe:'Максимум Шарпа',risk:'Эффективный риск',return:'Эффективная доходность'};
const descriptions={markowitz:'Максимум доходности с штрафом за риск. Чем выше λ, тем осторожнее портфель.',sharpe:'Максимум избыточной реальной доходности на единицу риска.',risk:'Минимальный риск при доходности не ниже заданного уровня.',return:'Максимальная доходность при риске не выше заданного лимита.'};
let data=demoData(),model,optimizer,current,saved=[],sequence=0,view='return',capital=1000000,rf=0,signature='',weightsColumns=0;
let activeTab='portfolio',selectedReportId='current',reportView='return';
const charts={};
let lastMessage;
let backtestView,importView;
function message(text,error=false,values={}){lastMessage={text,error,values};const portfolio=values.portfolioId&&saved.find(p=>p.id===values.portfolioId),details={...values,...portfolio?{name:portfolioName(portfolio)}:{},...values.criterionMode?{criterion:t(modes[values.criterionMode]),reason:translateError(values.reason)}:{}};$('message').textContent=error&&!values.criterionMode?translateError(text):t(text,details);$('message').classList.toggle('error',error);$('message').hidden=false;}
function modeFields(){
  const mode=$('mode').value;$('mode-description').textContent=t(descriptions[mode]);
  for(const [id,criterion] of [['lambda','markowitz'],['target-return','risk'],['target-risk','return']]) {
    $(id+'-field').hidden=mode!==criterion;$(id).disabled=mode!==criterion;
  }
}
function numeric(id){const value=$(id).value.trim();if(!value||!Number.isFinite(Number(value)))throw Error('Заполните числовой параметр: '+parameterLabels.get(id));return Number(value);}
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
    saved=[{...optimizer.solve('markowitz',{lambda:3,rf}),id:'p'+(++sequence),name:modes.markowitz,initial:true,color:colors[1],mode:'markowitz',settings:{lambda:3},visible:true}];
  }
  render();
  if(!quiet)message(cleared?'Портфель рассчитан. При смене периодичности или первого индикатора сравнение очищено.':'Портфель рассчитан. Добавьте результат к сравнению, затем выберите другой критерий.');
  return {name:portfolioName(current),weights:[...current.weights],expectedReturn:current.return,risk:current.risk};
}
function allPortfolios(){return [current,...saved];}
function visiblePortfolios(){return allPortfolios().filter(p=>p.visible);}
function stat(p){return metrics(model,p.weights,rf,capital);}
function render() {
  const s=stat(current);
  $('data-badge').textContent=data.demo?t('Учебные данные'):data.official?t('Официальные данные'):t('Ваш Excel');
  $('data-status').textContent=$('data-badge').textContent;
  $('upload-status').textContent=data.demo?t('Перетащите Excel сюда'):data.official?t(data.source):data.source;
  $('data-info').textContent=`${data.rows[0].date} — ${data.rows.at(-1).date} · ${data.rows.length} ${t('наблюдений')} · ${t('инфляция')} ${percent(model.inflation)} ${t('/ год')}`;
  $('demo-note').textContent=data.demo?t('Синтетические ряды для демонстрации расчётов. Для работы с историческими данными загрузите официальную статистику выше или свой Excel. Цены валют и активов должны быть выражены в рублях.'):data.official?t('Официальные месячные ряды ЦБ, Росстата и Мосбиржи. Доходности скорректированы на накопленный ИПЦ; подробности источников указаны выше.'):t('Источник: ')+data.source+t('. Все ряды скорректированы на ИПЦ из файла; экономическое содержание и рублёвые единицы проверьте по своим источникам.');
  $('current-title').textContent=portfolioName(current);
  $('expected-income').textContent=money(s.expectedIncome);
  $('expected-rate').textContent=percent(s.expectedReturn)+t(' реальной доходности / год');
  $('risk-value').textContent=percent(s.risk);
  $('drawdown-value').textContent=percent(s.maxDrawdown);
  $('recovery-value').textContent=recoveryText(s);
  $('recovery-note').textContent=s.recoveryIncomplete?t('Возврат к пику ещё не произошёл'):s.openRecovery?t('Текущее восстановление: ')+number(s.openRecovery)+' '+t('дн.'):t('По завершённым восстановлениям');
  $('indicators-table').querySelector('tbody').innerHTML=indicatorNames().map((name,i)=>`<tr><td>${String(i+1).padStart(2,'0')}</td><td><span class="asset-name"><span class="swatch" style="background:${colors[i]}"></span>${escape(name)}</span></td><td>${percent(model.mu[i])}</td><td>${percent(Math.sqrt(model.cov[i][i]))}</td><td><span class="weight-cell"><strong>${percent(current.weights[i])}</strong><span class="weight-bar"><span style="width:${current.weights[i]*100}%"></span></span></span></td></tr>`).join('');
  renderComparison();syncReportSelector();backtestView?.sync();renderCharts();
}
function renderComparison() {
  $('comparison-count').textContent=String(saved.length);
  const frequency={12:'Месячные данные',252:'Дневные данные',1:'Годовые данные'}[model.frequency];
  $('comparison-context').textContent=t('Капитал: {capital} · ставка: {rate} · {frequency}',{capital:money(capital),rate:percent(current.settings.nominalRf),frequency:t(frequency)});
  $('comparison-rf').textContent=percent(current.settings.nominalRf);
  $('comparison-return-limit').textContent=t('Максимальная доходность на этих данных: {rate}.',{rate:percent(Math.max(...model.mu))});
  $('comparison-risk-limit').textContent=t('Минимально возможный риск: {risk}.',{risk:percent(optimizer.global.risk)});
  for(const status of document.querySelectorAll('[data-criterion-status]')) {
    const count=saved.filter(p=>p.mode===status.dataset.criterionStatus).length;
    status.textContent=count?t('{count} в сравнении',{count}):t('Ещё не добавлен');status.classList.toggle('added',count>0);
  }
  $('comparison-cards').innerHTML=saved.length?saved.map(p=>`<div class="portfolio-chip"><input type="checkbox" ${p.visible?'checked':''} data-toggle="${p.id}" aria-label="${escape(t('Показать {name} на графиках',{name:portfolioName(p)}))}"><span class="swatch" style="background:${p.color}"></span><span>${escape(portfolioName(p))}</span><button data-remove="${p.id}" aria-label="${escape(t('Удалить {name}',{name:portfolioName(p)}))}">×</button></div>`).join(''):`<p class="empty-note">${escape(t('Добавьте текущий портфель, чтобы сравнить его с результатами других критериев.'))}</p>`;
  $('comparison-table').querySelector('tbody').innerHTML=allPortfolios().map(p=>{const s=stat(p);return `<tr><td><span class="asset-name"><span class="swatch" style="background:${p.color}"></span>${escape(portfolioName(p))}${p.id==='current'?t(' · текущий'):''}</span></td><td>${money(s.expectedIncome)}</td><td>${percent(s.expectedReturn)}</td><td>${percent(s.risk)}</td><td>${s.sharpe===null?t('Не определён'):new Intl.NumberFormat(locale(),{minimumFractionDigits:2,maximumFractionDigits:2}).format(s.sharpe)}</td><td>${percent(s.cagr)}</td><td>${percent(s.totalReturn)}</td><td>${percent(s.maxDrawdown)}</td><td>${recoveryText(s)}</td><td>${number(s.longestRecovery)} ${t('дн.')}</td><td>${s.openRecovery?'≥ '+number(s.openRecovery)+' '+t('дн.'):'—'}</td></tr>`;}).join('');
}
const chartLabels={'frontier-chart':'Эффективная граница и текущий портфель','equity-chart':'Кривая текущего портфеля','weights-chart':'Интерактивная круговая диаграмма весов текущего портфеля'};
function baseChart(id){const css=getComputedStyle(document.documentElement),muted=css.getPropertyValue('--muted').trim(),line=css.getPropertyValue('--chart-line').trim(),surface=css.getPropertyValue('--surface').trim();return {animation:!matchMedia('(prefers-reduced-motion: reduce)').matches,textStyle:{fontFamily:'IBM Plex Sans, Arial, sans-serif',color:muted,fontSize:12},aria:{enabled:true,label:{description:t(chartLabels[id])}},backgroundColor:surface,tooltip:{backgroundColor:surface,borderColor:line,confine:true,textStyle:{color:css.getPropertyValue('--text').trim()}}};}
function chart(id){return charts[id]??(charts[id]=echarts.init($(id),null,{renderer:'svg'}));}
function tooltipRows(items,value){return items.map(p=>`<div style="margin:5px 0"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${p.color};margin-right:7px"></span>${escape(p.seriesName)} <b>${escape(value(p))}</b></div>`).join('');}
function renderCharts() {
  if(activeTab==='backtest'){backtestView?.render();return;}
  if(activeTab==='graphs'){renderReportFigures();return;}
  if(activeTab!=='portfolio')return;
  const portfolios=[current],frontier=optimizer.frontier;
  const css=getComputedStyle(document.documentElement),chartLine=css.getPropertyValue('--chart-line').trim(),accent=css.getPropertyValue('--accent').trim(),accentSoft=css.getPropertyValue('--accent-soft').trim();
  chart('frontier-chart').setOption({...baseChart('frontier-chart'),grid:{left:58,right:18,top:30,bottom:56},tooltip:{...baseChart().tooltip,trigger:'item',formatter:p=>`${escape(p.seriesName)}<br>${t('Риск:')} <b>${percent(p.value[0]/100)}</b><br>${t('Доходность:')} <b>${percent(p.value[1]/100)}</b>`},xAxis:{type:'value',name:t('Риск, % / год'),nameLocation:'middle',nameGap:34,axisLabel:{color:baseChart().textStyle.color,formatter:axisPercent},splitLine:{lineStyle:{color:getComputedStyle(document.documentElement).getPropertyValue('--chart-line').trim()}}},yAxis:{type:'value',name:t('Доходность, % / год'),axisLabel:{color:baseChart().textStyle.color,formatter:axisPercent},splitLine:{lineStyle:{color:getComputedStyle(document.documentElement).getPropertyValue('--chart-line').trim()}}},series:[{name:t('Эффективная граница'),type:'line',data:frontier.map(p=>[p.risk*100,p.return*100]),symbol:'none',lineStyle:{color:colors[0],width:3},z:1},...portfolios.map(p=>({name:portfolioName(p),type:'scatter',data:[[p.risk*100,p.return*100]],symbolSize:p.id==='current'?15:12,itemStyle:{color:p.color,borderColor:baseChart().backgroundColor,borderWidth:2},z:3}))]},true);
  renderWeights();
  const useMoney=view==='wealth';
  chart('equity-chart').setOption({...baseChart('equity-chart'),color:portfolios.map(p=>p.color),legend:{top:0,type:'scroll',textStyle:{fontSize:12,color:baseChart().textStyle.color},itemWidth:16,itemHeight:3},tooltip:{...baseChart().tooltip,trigger:'axis',formatter:items=>escape(items[0]?.axisValue??'')+tooltipRows(items,p=>useMoney?money(p.value):percent(p.value/100))},grid:{left:useMoney?90:60,right:25,top:50,bottom:55},xAxis:{type:'category',boundaryGap:false,data:model.dates,axisLabel:{color:baseChart().textStyle.color,formatter:s=>s.slice(0,7),hideOverlap:true},axisLine:{lineStyle:{color:chartLine}}},yAxis:{type:'value',scale:view==='wealth',axisLabel:{color:baseChart().textStyle.color,formatter:v=>useMoney?number(v/1000)+t(' тыс.'):axisPercent(v)+'%'},splitLine:{lineStyle:{color:chartLine}}},dataZoom:[{type:'inside'},{type:'slider',height:15,bottom:5,borderColor:chartLine,fillerColor:accentSoft,handleStyle:{color:accent,borderColor:accent},moveHandleStyle:{color:accent},handleSize:14}],series:portfolios.map(p=>{const s=stat(p);return {name:portfolioName(p),type:'line',data:view==='wealth'?s.wealth.map(v=>v*capital):view==='return'?s.wealth.map(v=>(v-1)*100):s.drawdown.map(v=>v*100),symbol:'none',lineStyle:{width:p.id==='current'?3:2},emphasis:{focus:'series'}};})},true);
}
function renderWeights() {
  if(activeTab!=='portfolio')return;
  const ps=[current];
  const cols=Math.min(3,ps.length,Math.max(1,Math.floor($('weights-chart').clientWidth/190))),rows=Math.ceil(ps.length/cols),height=ps.length===1?290:rows*230;
  weightsColumns=cols;
  $('weights-chart').style.height=height+'px';
  const titles=ps.length>1?ps.map((p,i)=>({text:portfolioName(p),left:(i%cols+.5)*100/cols+'%',top:Math.floor(i/cols)*230+8,textAlign:'center',textStyle:{fontSize:12,fontWeight:500,width:180,overflow:'truncate',color:p.color}})):[];
  chart('weights-chart').resize();
  chart('weights-chart').setOption({...baseChart('weights-chart'),color:colors,title:titles,tooltip:{...baseChart().tooltip,trigger:'item',formatter:p=>`${escape(p.seriesName)}<br>${escape(p.name)}: <b>${percent(p.value/100)}</b>`},legend:ps.length===1?{type:'scroll',bottom:0,textStyle:{fontSize:12,color:baseChart().textStyle.color},itemWidth:9,itemHeight:9}:undefined,graphic:ps.length===1?[{type:'text',left:'center',top:'43%',style:{text:'100%',fontFamily:'IBM Plex Mono, monospace',fontSize:28,fontWeight:600,fill:colors[0]}},{type:'text',left:'center',top:'55%',style:{text:t('капитала'),fontFamily:'IBM Plex Sans, Arial, sans-serif',fontSize:12,fill:baseChart().textStyle.color}}]:[],series:ps.map((p,i)=>({name:portfolioName(p),type:'pie',radius:ps.length===1?['47%','71%']:[42,70],center:ps.length===1?['50%','46%']:[(i%cols+.5)*100/cols+'%',Math.floor(i/cols)*230+112],itemStyle:{borderColor:baseChart().backgroundColor,borderWidth:3,borderRadius:3},label:{show:false},emphasis:{scale:true,label:{show:ps.length>1,position:'center',formatter:'{b}\n{d}%',fontSize:12,color:baseChart().textStyle.color}},data:indicatorNames().map((name,j)=>({name,value:p.weights[j]*100,itemStyle:{color:colors[j]}})).filter(x=>x.value>1e-7)}))},true);
}
function savePortfolio() {
  if(saved.length>=8)throw Error('Можно сравнивать до 8 сохранённых портфелей. Удалите один, чтобы добавить новый.');
  const id='p'+(++sequence),suffix=current.mode==='markowitz'?' · λ = '+current.settings.lambda:current.mode==='risk'?t(' · цель ')+percent(current.settings.targetReturn):current.mode==='return'?t(' · риск ≤ ')+percent(current.settings.targetRisk):'';
  const name=portfolioName(current)+suffix+' #'+sequence;
  const color=colors.slice(1).find(color=>!saved.some(p=>p.color===color));
  saved.push({...current,id,name:current.name,ordinal:sequence,initial:false,color,weights:[...current.weights],visible:true});
  renderComparison();syncReportSelector();renderCharts();message('Портфель «{name}» добавлен. Выберите другой критерий и рассчитайте следующий.',false,{name,portfolioId:id});
  return {id,name};
}
function workbookDownload(book,name){XLSX.writeFile(book,name,{compression:true});}
function exportChart(id) {
  const names={'frontier-chart':t('Эффективная_граница'),'weights-chart':t('Веса_портфелей'),'equity-chart':view==='wealth'?t('Капитал_портфелей'):view==='return'?t('Доходность_портфелей'):t('Просадки_портфелей')};
  const reportNames={'report-frontier-chart':'Эффективная_граница','report-return-chart':'Доходность_портфелей','report-weights-chart':'Веса_портфелей','report-capital-chart':'Капитал_портфелей','report-drawdown-chart':'Просадки_портфелей','report-recovery-chart':'Восстановление_портфеля','report-comparison-chart':'Сравнение_портфелей'};
  const instance=charts[id]||getReportChart(id),filename=names[id]||t(reportNames[id]);
  if(!instance||!filename)throw Error('Сначала рассчитайте портфель.');
  const link=document.createElement('a');
  link.href=instance.getDataURL({type:'svg'});link.download=filename+'.svg';
  document.body.append(link);link.click();link.remove();
  message('Рисунок сохранён в SVG. Его можно вставить в отчёт или презентацию.');
}
function template() {
  const d=demoData(),book=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([[t('Дата'),t('ИПЦ'),...d.names.map(n=>t(n))],...d.rows.map(r=>[r.date,Number(r.cpi.toFixed(6)),...r.values.map(v=>Number(v.toFixed(6)))])]),t('Данные'));
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([[t('Памятка')],[t('Это синтетические данные, а не исторические котировки. Замените их своими рядами.')],[t('Первый лист: Дата, ИПЦ и ровно 10 индикаторов. Уровни положительны; даты строго возрастают.')],[t('ИПЦ — накопленный индекс цен (например 100, 100.5), не месячный процент инфляции.')],[t('Одна строка на конец каждого месяца; минимум 13 строк. Можно выбрать дневную или годовую частоту в приложении.')],[t('Все котировки и цены активов предварительно переведите в рубли. Для выплат используйте полную доходность.')],[t('Индикатор 1 — рублёвая масса М2. Его вес имеет учебную интерпретацию.')],[t('Введите реальные источники, единицы и описание выборки для вашей работы.')]]),t('Инструкция'));
  workbookDownload(book,t('Шаблон_10_индикаторов.xlsx'));message('Excel-шаблон скачан. На первом листе замените учебные уровни своими данными.');
}
function applyDataset(next,{profile,official=false}={}) {
  const old={data,model,optimizer,current,saved,signature,capital,rf};
  const ids=['mode','lambda','rf','frequency','first-indicator','capital'],fields=Object.fromEntries(ids.map(id=>[id,$(id).value]));
  try {
    if(profile||official) {
      $('frequency').value='12';$('first-indicator').value='m2';$('capital').value=String(capital);
      $('rf').value=profile?'8':String((current?.settings.nominalRf??.08)*100);
    }
    data=next;signature='';model=null;saved=[];$('mode').value=profile?'sharpe':'markowitz';$('lambda').value='3';modeFields();calculate({quiet:true});
  }catch(error) {
    ({data,model,optimizer,current,saved,signature,capital,rf}=old);
    for(const id of ids)$(id).value=fields[id];modeFields();throw error;
  }
  if(official){lastMessage=null;$('message').hidden=true;}
}
async function upload(file) {
  if(!file)return;
  if(!/\.(xlsx|xls)$/i.test(file.name))throw Error('Выберите файл .xlsx или .xls.');
  if(file.size>10*1024*1024)throw Error('Файл должен быть не больше 10 МБ.');
  const book=XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:true});
  if(!book.SheetNames.length)throw Error('В файле нет листов.');
  const next=parseTable(XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,defval:null,raw:true}));
  const parameters=book.Sheets['Параметры']?XLSX.utils.sheet_to_json(book.Sheets['Параметры'],{header:1}):[];
  const declaredProfile=parameters.find(row=>row[0]==='Профиль')?.[1];
  const profile=['m2-90-67','m2-60-67'].includes(declaredProfile)?declaredProfile:null;
  applyDataset({...next,source:profile?'Учебный пример · синтетические данные':file.name,demo:!!profile},{profile});
  if(profile)message('Учебный пример загружен. Максимум Шарпа, ставка 8%, месячные данные. Доля М2: {weight}.',false,{weight:percent(current.weights[0])});
  else message('Excel загружен: {count} наблюдений, 10 индикаторов. Сравнение очищено; начальный расчёт выполнен по Марковицу с λ = 3.',false,{count:next.rows.length});
}
function exportResults() {
  const book=XLSX.utils.book_new(),ps=allPortfolios();
  const summary=[[t('Портфель'),t('Ожидаемая доходность / год'),t('Волатильность / год'),t('Шарп'),'CAGR',t('Историческая доходность'),t('Макс. просадка'),t('Макс. завершённое восстановление, дни'),t('Текущее восстановление, дни'),t('Ожидаемый реальный доход, ₽'),t('Макс. период восстановления, дни'),t('Максимальное восстановление незавершено')]];
  ps.forEach(p=>{const s=stat(p);summary.push([portfolioName(p),s.expectedReturn,s.risk,s.sharpe,s.cagr,s.totalReturn,s.maxDrawdown,s.longestRecovery,s.openRecovery,s.expectedIncome,s.maxRecovery,s.recoveryIncomplete?t('Да'):t('Нет')]);});
  const add=(rows,name)=>XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),name);
  add(summary,t('Показатели'));add([[t('Индикатор'),...ps.map(p=>portfolioName(p))],...indicatorNames().map((n,i)=>[n,...ps.map(p=>p.weights[i])])],t('Веса'));
  const stats=ps.map(stat);
  add([[t('Дата'),...ps.map(p=>portfolioName(p))],...model.dates.map((date,i)=>[date,...stats.map(s=>s.wealth[i]*capital)])],t('Реальный капитал'));
  add([[t('Дата'),...ps.map(p=>portfolioName(p))],...model.dates.map((date,i)=>[date,...stats.map(s=>s.drawdown[i])])],t('Просадки'));
  add([[t('Риск / год'),t('Ожид. доходность / год'),...indicatorNames()],...optimizer.frontier.map(p=>[p.risk,p.return,...p.weights])],t('Эффективная граница'));
  add([[t('Дата'),t('ИПЦ'),...data.names.map(n=>data.demo?t(n):n)],...data.rows.map(r=>[r.date,r.cpi,...r.values])],t('Исходные данные'));
  add([[t('Дата'),...indicatorNames()],...model.returns.map((r,i)=>[model.dates[i+1],...r])],t('Реальные доходности'));
  add([[t('Параметр'),t('Значение')],[t('Источник'),(data.demo?t(data.source):data.source)],[t('Синтетические данные'),data.demo?t('Да'):t('Нет')],[t('Периодов в год'),model.frequency],[t('Начальный капитал, ₽'),capital],[t('Номинальная ставка'),current.settings.nominalRf],[t('Реальная безрисковая ставка'),rf],[t('Годовая инфляция'),model.inflation],[t('Индикатор 1'),indicatorNames()[0]],[t('Формула доходности'),t('(P_t/P_(t-1))/(ИПЦ_t/ИПЦ_(t-1))-1')],[t('Ожидаемая доходность'),t('Частота × средняя периодическая доходность')],[t('Ковариация'),t('Частота × выборочная ковариация')],[t('Ребалансировка'),t('Каждый период, без комиссий и налогов')],[t('Проверка прогноза'),t('Кривая построена на обучающей выборке; вневыборочной проверки нет')],...ps.map(p=>[t('Критерий: ')+portfolioName(p),JSON.stringify(p.settings)])],t('Методика'));
  workbookDownload(book,t('Сравнение_портфелей.xlsx'));message('Показатели, веса, кривые и исходные данные сохранены в Excel. Доходности в файле записаны долями: 0,1 = 10%.');
}
function guarded(action){return async(...args)=>{try{await action(...args);}catch(e){message(e.message||t('Не удалось выполнить действие.'),true);}};}

function portfolioName(p) {
  const base=t(modes[p.mode]);
  if(p.initial)return base+' · λ = 3';
  if(!p.ordinal)return base;
  const suffix=p.mode==='markowitz'?' · λ = '+p.settings.lambda:p.mode==='risk'?t(' · цель ')+percent(p.settings.targetReturn):p.mode==='return'?t(' · риск ≤ ')+percent(p.settings.targetRisk):'';
  return base+suffix+' #'+p.ordinal;
}
function indicatorNames() {
  return model.names.map((name,i)=>signature.endsWith(':true')&&i===0?t('Рублёвый остаток'):data.demo||data.official?t(name):name);
}
function sameCriterion(portfolio,mode,settings) {
  if(portfolio.mode!==mode)return false;
  const key={markowitz:'lambda',sharpe:'rf',risk:'targetReturn',return:'targetRisk'}[mode];
  return Number.isFinite(portfolio.settings[key])&&Math.abs(portfolio.settings[key]-settings[key])<1e-10;
}
function prepareComparison(modesToAdd) {
  if(!current||!optimizer)throw Error('Сначала рассчитайте портфель.');
  return modesToAdd.map(mode=>{
    try {
      const settings={rf,nominalRf:current.settings.nominalRf,lambda:mode==='markowitz'?numeric('compare-lambda'):3,targetReturn:mode==='risk'?numeric('compare-target-return')/100:.1,targetRisk:mode==='return'?numeric('compare-target-risk')/100:.2};
      const solution=optimizer.solve(mode,settings);
      metrics(model,solution.weights,rf,capital);
      return {mode,settings,solution,existing:saved.find(p=>sameCriterion(p,mode,settings))};
    } catch(error){error.criterionMode=mode;throw error;}
  });
}
async function addCriteriaToComparison(modesToAdd) {
  const buttons=[...document.querySelectorAll('[data-add-criterion],#compare-all-button')];
  buttons.forEach(button=>button.disabled=true);
  try {
    await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
    const planned=prepareComparison(modesToAdd),newCount=planned.filter(p=>!p.existing).length;
    if(saved.length+newCount>8)throw Error('Можно сравнивать до 8 сохранённых портфелей. Удалите один, чтобы добавить новый.');
    for(const item of planned) {
      if(item.existing){item.existing.visible=true;continue;}
      const ordinal=++sequence,color=colors.slice(1).find(color=>!saved.some(p=>p.color===color));
      const portfolio={...item.solution,id:'p'+ordinal,name:modes[item.mode],mode:item.mode,settings:{...item.settings},ordinal,initial:false,color,visible:true,weights:[...item.solution.weights]};
      saved.push(portfolio);item.existing=portfolio;
    }
    renderComparison();syncReportSelector();renderCharts();
    if(modesToAdd.length===4)message(newCount?'Сравнение 4 критериев готово. Новых портфелей: {count}.':'Все 4 критерия уже есть в сравнении.',false,{count:newCount});
    else message(newCount?'Портфель «{name}» рассчитан и добавлен в таблицу ниже.':'Портфель «{name}» уже есть в таблице сравнения.',false,{portfolioId:planned[0].existing.id});
  } catch(error) {
    if(error.criterionMode)message('Не удалось рассчитать «{criterion}»: {reason}',true,{criterionMode:error.criterionMode,reason:error.message});
    else message(error.message,true);
  } finally {
    buttons.forEach(button=>button.disabled=false);
    requestAnimationFrame(()=>$('message').scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'}));
  }
}
function syncReportSelector() {
  if(!current)return;
  if(!allPortfolios().some(p=>p.id===selectedReportId))selectedReportId='current';
  $('report-portfolio').innerHTML=allPortfolios().map(p=>`<option value="${escape(p.id)}">${escape(portfolioName(p))}${p.id==='current'?t(' · текущий'):''}</option>`).join('');
  $('report-portfolio').value=selectedReportId;
}
function renderReportFigures() {
  if(!current)return;
  syncReportSelector();
  renderReport({model,frontier:optimizer.frontier,portfolios:allPortfolios().map(p=>({...p,displayName:portfolioName(p)})),stats:stat,indicatorNames:indicatorNames(),colors,selectedId:selectedReportId,capital,comparisonView:reportView});
}
function resizeVisibleCharts() {
  if(activeTab==='portfolio')Object.values(charts).forEach(c=>c.resize());
  if(activeTab==='graphs')resizeReport();
  if(activeTab==='backtest')backtestView?.resize();
}
function activateTab(name,{focus=false,updateHash=true}={}) {
  if(!['portfolio','graphs','comparison','backtest','data'].includes(name))return;
  activeTab=name;
  $(name==='comparison'?'comparison-feedback-slot':'global-message-slot').append($('message'));
  for(const button of document.querySelectorAll('[data-tab]')) {
    const selected=button.dataset.tab===name;
    button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;
    $('panel-'+button.dataset.tab).hidden=!selected;
  }
  if(updateHash)history.replaceState(null,'','#'+name);
  if(focus)$('tab-'+name).focus();
  if(current)renderCharts();
  requestAnimationFrame(resizeVisibleCharts);
}
function preferenceLabels() {
  $('language-button').textContent=language==='ru'?'EN':'RU';
  $('language-button').setAttribute('aria-label',t(language==='ru'?'Переключить на английский':'Переключить на русский'));
  const themeLabel=t(theme==='light'?'Тёмная тема':'Светлая тема');
  const themeIcon=theme==='light'?'<path d="M20.4 14.5A8.5 8.5 0 0 1 9.5 3.6 8.5 8.5 0 1 0 20.4 14.5Z"/>':'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  $('theme-button').innerHTML=`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${themeIcon}</svg><span class="sr-only">${theme==='light'?'☾ ':'☀ '}${escape(themeLabel)}</span>`;
  $('theme-button').setAttribute('aria-label',themeLabel);
  $('theme-button').setAttribute('aria-pressed',String(theme==='dark'));
}
captureStaticTranslations();setTheme(theme);translateStatic();preferenceLabels();
function refreshPreferences() {
  translateStatic();preferenceLabels();modeFields();
  if(current)render();
  importView?.render();
  if(lastMessage)message(lastMessage.text,lastMessage.error,lastMessage.values);
  requestAnimationFrame(resizeVisibleCharts);
}
$('language-button').addEventListener('click',()=>{setLanguage(language==='ru'?'en':'ru');refreshPreferences();});
$('theme-button').addEventListener('click',()=>{
  const oldColors=colors;setTheme(theme==='light'?'dark':'light');colors=theme==='dark'?darkColors:lightColors;
  if(current)allPortfolios().forEach(p=>{p.color=colors[oldColors.indexOf(p.color)]||colors[0];});
  refreshPreferences();
});

$('mode').addEventListener('change',modeFields);
$('optimization-form').addEventListener('submit',guarded(async e=>{e.preventDefault();$('calculate-button').disabled=true;$('save-button').disabled=true;try{await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));calculate();}finally{$('calculate-button').disabled=false;$('save-button').disabled=false;}}));
$('save-button').addEventListener('click',guarded(savePortfolio));
$('compare-all-button').addEventListener('click',()=>addCriteriaToComparison(['markowitz','sharpe','risk','return']));
document.querySelectorAll('[data-add-criterion]').forEach(button=>button.addEventListener('click',()=>addCriteriaToComparison([button.dataset.addCriterion])));
$('template-button').addEventListener('click',guarded(template));
$('export-button').addEventListener('click',guarded(exportResults));
document.querySelectorAll('[data-download]').forEach(button=>button.addEventListener('click',guarded(()=>exportChart(button.dataset.download))));
$('file-input').addEventListener('change',guarded(async e=>{try{await upload(e.target.files[0]);}finally{e.target.value='';}}));
const uploadFrame=$('upload-frame');
let uploadDragDepth=0;
uploadFrame.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('file-input').click();}});
uploadFrame.addEventListener('dragenter',e=>{e.preventDefault();uploadDragDepth++;uploadFrame.classList.add('dragging');});
uploadFrame.addEventListener('dragover',e=>{e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='copy';});
uploadFrame.addEventListener('dragleave',e=>{e.preventDefault();uploadDragDepth=Math.max(0,uploadDragDepth-1);if(!uploadDragDepth)uploadFrame.classList.remove('dragging');});
uploadFrame.addEventListener('drop',guarded(async e=>{e.preventDefault();uploadDragDepth=0;uploadFrame.classList.remove('dragging');await upload(e.dataTransfer?.files[0]);}));
$('demo-button').addEventListener('click',guarded(()=>{data=demoData();model=null;signature='';saved=[];$('frequency').value='12';$('first-indicator').value='m2';$('mode').value='sharpe';$('rf').value='8';$('capital').value='1000000';modeFields();calculate({quiet:true,initial:true});message('Учебные данные восстановлены.');}));
$('comparison-cards').addEventListener('change',e=>{const p=saved.find(p=>p.id===e.target.dataset.toggle);if(p){p.visible=e.target.checked;renderCharts();}});
$('comparison-cards').addEventListener('click',e=>{const id=e.target.dataset.remove;if(id){saved=saved.filter(p=>p.id!==id);renderComparison();syncReportSelector();renderCharts();}});
$('weights-view').addEventListener('change',renderWeights);
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{view=b.dataset.view;document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('active',x===b));renderCharts();}));
$('report-portfolio').addEventListener('change',()=>{selectedReportId=$('report-portfolio').value;renderReportFigures();});
$('report-comparison-view').addEventListener('change',()=>{reportView=$('report-comparison-view').value;renderReportFigures();});
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>activateTab(button.dataset.tab)));
document.querySelector('.app-tabs').addEventListener('keydown',e=>{
  const buttons=[...document.querySelectorAll('[data-tab]')],index=buttons.indexOf(e.target);
  if(index<0)return;
  const next=e.key==='ArrowRight'?(index+1)%buttons.length:e.key==='ArrowLeft'?(index+buttons.length-1)%buttons.length:e.key==='Home'?0:e.key==='End'?buttons.length-1:-1;
  if(next>=0){e.preventDefault();activateTab(buttons[next].dataset.tab,{focus:true});}
});
document.querySelectorAll('[data-open-tab],[data-scroll-target]').forEach(button=>button.addEventListener('click',e=>{
  e.preventDefault();
  if(button.dataset.openTab)activateTab(button.dataset.openTab);
  if(button.dataset.scrollTarget)requestAnimationFrame(()=>$('report-comparison').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'}));
}));
window.addEventListener('hashchange',()=>activateTab(location.hash.slice(1),{updateHash:false}));
$('method-button').addEventListener('click',()=>$('method-dialog').showModal());
$('close-method').addEventListener('click',()=>$('method-dialog').close());
$('method-dialog').addEventListener('click',e=>{if(e.target===$('method-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
new ResizeObserver(resizeVisibleCharts).observe(document.querySelector('.app-main'));
backtestView=createBacktestView(()=>current?{data,frequency:model.frequency,cash:signature.endsWith(':true'),capital,nominalRf:current.settings.nominalRf}:null);
importView=createDataImportView({applyDataset,uploadExample:async file=>{await upload(file);activateTab('portfolio');}});
modeFields();
try {if(!window.echarts||!window.XLSX)throw Error(t('Не загрузились библиотеки графиков или Excel. Перезапустите приложение.'));calculate({quiet:true,initial:true});}catch(e){message(e.message,true);}
activateTab(location.hash.slice(1)||'portfolio',{updateHash:false});
document.fonts.ready.then(()=>requestAnimationFrame(()=>{if(current){resizeVisibleCharts();renderCharts();}}));
