import {estimate,createOptimizer,metrics} from './engine.js';
import {t,locale,language,theme,setLanguage,setTheme,captureStaticTranslations,translateStatic,translateError} from './i18n.js';
import {renderReport,resizeReport,getReportChart} from './report-charts.js';
import {weightBounds,exposures,exposureLimits} from './constrained-optimizer.js';
import {signedWeightsOption} from './weight-charts.js';
import {createBacktestView} from './backtest-ui.js';
import {createDataImportView} from './data-import-ui.js';
import {macroSeries} from './macro.js';
import {comparisonMetrics,evaluatePortfolio,comparisonStat as calculateComparisonStat,reportPortfolio,metricComparison,discardGeneratedComparisonSets} from './comparison.js';
import {createComparisonControls} from './comparison-controls.js';
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
let data=null,model,optimizer,current,saved=[],sequence=0,view='return',capital=1000000,rf=0,signature='',weightsColumns=0;
let excludedAssets=[];
let activeTab='portfolio',selectedReportId='current',reportView='return';
const charts={};
let lastMessage;
let backtestView,importView,comparisonControls;
let comparisonPeriod=null,baselineId='current',highlightComparison=true;
function message(text,error=false,values={}){lastMessage={text,error,values};const portfolio=values.portfolioId&&saved.find(p=>p.id===values.portfolioId),details={...values,...portfolio?{name:portfolioName(portfolio)}:{},...values.criterionMode?{criterion:t(modes[values.criterionMode]),reason:translateError(values.reason)}:{}};$('message').textContent=error&&!values.criterionMode?translateError(text):t(text,details);$('message').classList.toggle('error',error);$('message').hidden=false;}
function modeFields(){
  positionFields();
  const mode=$('mode').value;$('mode-description').textContent=t(descriptions[mode]);
  for(const [id,criterion] of [['lambda','markowitz'],['target-return','risk'],['target-risk','return']]) {
    $(id+'-field').hidden=mode!==criterion;$(id).disabled=mode!==criterion;
  }
}
function numeric(id){const value=$(id).value.trim();if(!value||!Number.isFinite(Number(value)))throw Error('Заполните числовой параметр: '+($(id).labels?.[0]?.textContent||parameterLabels.get(id)));return Number(value);}
function constraintsFromInputs(){
  const short=$('position-mode').value==='short';
  return {short,minWeight:numeric('min-weight')/100,maxWeight:numeric('max-weight')/100,excluded:[...excludedAssets],...short?{grossLimit:numeric('gross-limit')/100,shortLimit:numeric('short-limit')/100}:{}};
}
function positionFields(){
  const short=$('position-mode').value==='short';$('short-exposure-fields').hidden=!short;
  for(const id of ['gross-limit','short-limit'])$(id).disabled=!short;
  $('min-weight-label').textContent=t(short?'Минимальный вес одного актива, %':'Минимальная доля актива, %');
  const gross=Number($('gross-limit').value),limit=Number($('short-limit').value),warnings=[];
  if(short&&gross===100)warnings.push(t('При валовой экспозиции 100% и сумме весов 100% короткие позиции фактически невозможны.'));
  if(short&&$('short-limit').value.trim()&&limit===0)warnings.push(t('Лимит short равен 0%: короткие позиции запрещены.'));
  $('exposure-limit-warning').textContent=warnings.join(' ');$('exposure-limit-warning').hidden=!warnings.length;
}
function calculationSignature(covariance,constraints){return JSON.stringify({frequency:12,covariance,constraints});}
const inputPercent=value=>Number((value*100).toFixed(10));
function restoreStrategyInputs(settings){
  const constraints=settings.constraints||{short:false,minWeight:0,maxWeight:1,excluded:[]};
  excludedAssets=[...(constraints.excluded||[])];$('position-mode').value=constraints.short?'short':'long';$('min-weight').min=constraints.short?'-100':'0';$('min-weight').value=inputPercent(constraints.minWeight??(constraints.short?-.3:0));$('max-weight').value=inputPercent(constraints.maxWeight??1);$('covariance-method').value=settings.covariance||'sample';$('gross-limit').value=inputPercent(constraints.grossLimit??1.5);$('short-limit').value=inputPercent(constraints.shortLimit??.25);positionFields();
}
function calculate({quiet=false}={}) {
  if(!data)throw Error('Сначала загрузите официальную статистику.');
  const newCapital=numeric('capital'),nominalRf=numeric('rf')/100;
  if(newCapital<=0||newCapital>1e15)throw Error('Начальный капитал должен быть больше нуля и не превышать 10¹⁵ ₽.');
  if(nominalRf<=-1)throw Error('Безрисковая ставка должна быть выше −100%.');
  const frequency=12;
  const constraints=constraintsFromInputs(),covariance=$('covariance-method').value;
  weightBounds(data.names.length-1,constraints);
  const newSignature=calculationSignature(covariance,constraints);
  const nextModel=!model||model.covariance!==covariance||JSON.stringify(model.excluded)!==JSON.stringify(constraints.excluded)?estimate(data,frequency,{covariance,excluded:constraints.excluded}):model;
  const nextOptimizer=newSignature===signature&&nextModel===model?optimizer:createOptimizer(nextModel,constraints);
  const nextRf=(1+nominalRf)/(1+nextModel.inflation)-1;
  const mode=$('mode').value;
  const settings={constraints,covariance,rf:nextRf,lambda:mode==='markowitz'?numeric('lambda'):3,targetReturn:mode==='risk'?numeric('target-return')/100:.1,targetRisk:mode==='return'?numeric('target-risk')/100:.2};
  const solution=nextOptimizer.solve(mode,settings);
  metrics(nextModel,solution.weights,nextRf,newCapital);
  const cleared=newSignature!==signature&&!!model;
  if(cleared){for(const p of saved)if(!p.snapshot)p.snapshot={data,model,frontier:optimizer.frontier};}
  model=nextModel;optimizer=nextOptimizer;capital=newCapital;rf=nextRf;signature=newSignature;
  current={...solution,compared:true,id:'current',name:modes[mode],color:colors[0],mode,settings:{...settings,nominalRf},visible:true};
  render();
  if(!quiet)message('Портфель рассчитан. Добавьте результат к сравнению, затем выберите другой критерий.');
  return {name:portfolioName(current),weights:[...current.weights],expectedReturn:current.return,risk:current.risk};
}
function allPortfolios(){return [current,...saved];}
function comparisonPortfolios(){return current?allPortfolios().filter(p=>p.compared!==false):[];}
function stat(p){return metrics(p.snapshot?.model||model,p.weights,p.snapshot?p.settings.rf:rf,capital);}
function comparisonContext(){return {data,model,capital,rf,nominalRf:current.settings.nominalRf};}
function comparisonStat(p){return calculateComparisonStat(p,comparisonContext(),comparisonPeriod);}
function comparisonState(){return {...comparisonContext(),current,saved,sequence,period:comparisonPeriod,baselineId,selectedReportId,reportView,highlight:highlightComparison};}
function setComparisonPeriod(period){
  comparisonPortfolios().forEach(p=>calculateComparisonStat(p,comparisonContext(),period));
  comparisonPeriod=period;renderComparison();renderCharts();
}
function restoreComparisonState(state){
  ({data,model,current,saved,sequence,capital,rf,signature,baselineId,selectedReportId,reportView}=state);
  optimizer=state.optimizer;comparisonPeriod=state.period;highlightComparison=state.highlight;
  allPortfolios().forEach((p,i)=>p.color=colors[i]);
  for(const [id,value] of Object.entries({mode:current.mode,capital,rf:current.settings.nominalRf*100,frequency:model.frequency,lambda:current.settings.lambda??3,'target-return':(current.settings.targetReturn??.1)*100,'target-risk':(current.settings.targetRisk??.2)*100}))$(id).value=String(value);
  restoreStrategyInputs(current.settings);signature=calculationSignature(current.settings.covariance||'sample',constraintsFromInputs());
  $('report-comparison-view').value=reportView;modeFields();render();
}
function render() {
  if(!current)return;
  setReady(true);
  const s=stat(current),e=exposures(current.weights);
  $('position-summary').textContent=t(current.settings.constraints?.short?'Короткие продажи':'Без коротких продаж');
  for(const key of ['long','short','net','gross'])$(key+'-exposure').textContent=percent(e[key]);
  $('covariance-summary').textContent=model.covariance==='oas'?t('OAS · сжатие {rate}',{rate:percent(model.shrinkage)}):t('Выборочная ковариация');
  $('asset-toggles').innerHTML=indicatorNames().map((name,i)=>`<label><input type="checkbox" data-asset="${i}" ${excludedAssets.includes(i)?'':'checked'}><span>${escape(name)}</span></label>`).join('');
  $('data-badge').textContent=t('Официальные данные');
  $('data-status').textContent=t('Официальные данные');
  $('data-info').textContent=`${data.rows[0].date} — ${data.rows.at(-1).date} · ${data.rows.length} ${t('наблюдений')} · ${t('инфляция')} ${percent(model.inflation)} ${t('/ год')}`;
  const macro=macroSeries(data);
  $('inflation-total').textContent=percent(macro.accumulatedInflation.at(-1));
  $('inflation-annual').textContent=percent(model.inflation);
  $('m2-growth').textContent=percent(macro.moneyGrowth.at(-1));
  $('m2-level').textContent=number(macro.moneySupply.at(-1))+' '+t('млрд ₽');
  $('current-title').textContent=portfolioName(current);
  $('expected-income').textContent=money(s.expectedIncome);
  $('expected-rate').textContent=percent(s.expectedReturn)+t(' реальной доходности / год');
  $('risk-value').textContent=percent(s.risk);
  $('drawdown-value').textContent=percent(s.maxDrawdown);
  $('recovery-value').textContent=recoveryText(s);
  $('recovery-note').textContent=s.recoveryIncomplete?t('Возврат к пику ещё не произошёл'):s.openRecovery?t('Текущее восстановление: ')+number(s.openRecovery)+' '+t('дн.'):t('По завершённым восстановлениям');
  $('indicators-table').querySelector('tbody').innerHTML=indicatorNames().map((name,i)=>`<tr><td>${String(i+1).padStart(2,'0')}</td><td><span class="asset-name"><span class="swatch" style="background:${colors[i]}"></span>${escape(name)}</span></td><td>${percent(model.mu[i])}</td><td>${percent(Math.sqrt(model.cov[i][i]))}</td><td><span class="weight-cell"><strong>${percent(current.weights[i])}</strong><span class="weight-bar"><span style="width:${Math.abs(current.weights[i])*100}%;background:${current.weights[i]<0?"var(--muted)":"var(--accent)"}"></span></span></span></td></tr>`).join('');
  renderComparison();syncReportSelector();backtestView?.sync();renderCharts();
}
function renderComparison() {
  const frequency={12:'Месячные данные',252:'Дневные данные',1:'Годовые данные'}[model.frequency];
  $('comparison-context').textContent=t('Капитал: {capital} · ставка: {rate} · {frequency}',{capital:money(capital),rate:percent(current.settings.nominalRf),frequency:t(frequency)});
  $('comparison-rf').textContent=percent(current.settings.nominalRf);
  $('comparison-return-limit').textContent=t('Максимальная доходность на этих данных: {rate}.',{rate:percent(optimizer.max)});
  $('comparison-risk-limit').textContent=t('Минимально возможный риск: {risk}.',{risk:percent(optimizer.global.risk)});
  for(const status of document.querySelectorAll('[data-criterion-status]')) {
    const count=saved.filter(p=>p.mode===status.dataset.criterionStatus).length;
    status.textContent=count?t('{count} в сравнении',{count}):t('Ещё не добавлен');status.classList.toggle('added',count>0);
  }
  const ps=comparisonPortfolios();
  $('comparison-count').textContent=String(ps.length);
  $('export-button').disabled=!ps.length;
  $('comparison-cards').innerHTML=ps.length?[...saved,...(current.compared!==false?[current]:[])].map(p=>`<div class="${p.id==='current'?'portfolio-chip current-portfolio-chip':'portfolio-chip'}"><input type="checkbox" ${p.visible?'checked':''} data-toggle="${p.id}" aria-label="${escape(t('Показать {name} на графиках',{name:portfolioName(p)}))}"><span class="swatch" style="background:${p.color}"></span><span>${escape(portfolioName(p))}${p.id==='current'?t(' · текущий'):''}</span><button type="button" data-remove="${p.id}" aria-label="${escape(t('Удалить {name}',{name:portfolioName(p)}))}" title="${escape(t('Убрать из сравнения'))}">×</button></div>`).join(''):`<p class="empty-note">${escape(t('Сравнение пусто. Рассчитайте и добавьте портфель по официальным данным.'))}</p>`;
  if(comparisonPeriod){try{ps.forEach(comparisonStat);}catch{comparisonPeriod=null;message('Общий период сброшен: изменился состав или данные портфелей.');}}
  if(!ps.some(p=>p.id===baselineId))baselineId=ps[0]?.id||'current';
  comparisonControls?.render(ps,comparisonContext(),comparisonPeriod,baselineId,highlightComparison);
  const stats=ps.map(comparisonStat),baselineIndex=ps.findIndex(p=>p.id===baselineId);
  const ranks=comparisonMetrics.map(([key,direction])=>metricComparison(stats,key,direction));
  function metricCell(stat,index,metricIndex){
    const [key,direction,unit]=comparisonMetrics[metricIndex],rank=ranks[metricIndex],value=stat[key];
    const formatted=unit==='percent'?percent(value):unit==='money'?money(value):key==='maxRecovery'?recoveryText(stat):key==='openRecovery'&&!value?'—':unit==='days'?(key==='openRecovery'?'≥ ':'')+number(value)+' '+t('дн.'):value===null?t('Не определён'):new Intl.NumberFormat(locale(),{minimumFractionDigits:2,maximumFractionDigits:2}).format(value);
    const best=highlightComparison&&rank.best.includes(index),worst=highlightComparison&&rank.worst.includes(index);
    let difference='';
    if(index!==baselineIndex&&baselineIndex>=0&&Number.isFinite(value)&&Number.isFinite(stats[baselineIndex][key])&&rank.comparable){
      const delta=value-stats[baselineIndex][key],sign=delta>0?'+':delta<0?'−':'';
      const differenceValue=unit==='percent'?new Intl.NumberFormat(locale(),{minimumFractionDigits:2,maximumFractionDigits:2}).format(Math.abs(delta)*100)+' '+t('п.п.'):unit==='money'?money(Math.abs(delta)):unit==='days'?number(Math.abs(delta))+' '+t('дн.'):new Intl.NumberFormat(locale(),{minimumFractionDigits:2,maximumFractionDigits:2}).format(Math.abs(delta));
      const directionClass=highlightComparison&&Math.abs(delta)>1e-10?(delta*direction>0?' improvement':' decline'):'';
      difference=`<small class="metric-difference${directionClass}" title="${escape(t('Разница с {name}',{name:portfolioName(ps[baselineIndex])}))}">Δ ${sign}${escape(differenceValue)}</small>`;
    }
    return `<td data-metric="${key}" class="${best?'metric-best':worst?'metric-worst':''}">${escape(formatted)}${best||worst?`<span class="sr-only"> · ${escape(t(best?'Лучшее значение':'Худшее значение'))}</span>`:''}${difference}</td>`;
  }
  $('comparison-table').querySelector('tbody').innerHTML=ps.map((p,i)=>{
    const sourceModel=evaluatePortfolio(p,comparisonContext(),comparisonPeriod).model;
    return `<tr data-portfolio-id="${p.id}" data-baseline="${p.id===baselineId}"><td><span class="asset-name"><span class="swatch" style="background:${p.color}"></span>${escape(portfolioName(p))}${p.id==='current'?t(' · текущий'):''}</span><small class="comparison-source">${escape(t('Официальные данные'))} · ${sourceModel.dates[0]} — ${sourceModel.dates.at(-1)}</small></td>${comparisonMetrics.map((_,j)=>metricCell(stats[i],i,j)).join('')}</tr>`;
  }).join('');
}
const chartLabels={'frontier-chart':'Эффективная граница и текущий портфель','equity-chart':'Кривая текущего портфеля','weights-chart':'Диаграмма весов текущего портфеля'};
function baseChart(id){const css=getComputedStyle(document.documentElement),muted=css.getPropertyValue('--muted').trim(),line=css.getPropertyValue('--chart-line').trim(),surface=css.getPropertyValue('--surface').trim();return {animation:!matchMedia('(prefers-reduced-motion: reduce)').matches,textStyle:{fontFamily:'IBM Plex Sans, Arial, sans-serif',color:muted,fontSize:12},aria:{enabled:true,label:{description:t(chartLabels[id])}},backgroundColor:surface,tooltip:{backgroundColor:surface,borderColor:line,confine:true,textStyle:{color:css.getPropertyValue('--text').trim()}}};}
function chart(id){return charts[id]??(charts[id]=echarts.init($(id),null,{renderer:'svg'}));}
function tooltipRows(items,value){return items.map(p=>`<div style="margin:5px 0"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${p.color};margin-right:7px"></span>${escape(p.seriesName)} <b>${escape(value(p))}</b></div>`).join('');}
function renderCharts() {
  if(activeTab==='backtest'){backtestView?.render();return;}
  if(!current)return;
  if(activeTab==='graphs'){renderReportFigures();renderMacroCharts();return;}
  if(activeTab!=='portfolio')return;
  const portfolios=[current],frontier=optimizer.frontier;
  const css=getComputedStyle(document.documentElement),chartLine=css.getPropertyValue('--chart-line').trim(),accent=css.getPropertyValue('--accent').trim(),accentSoft=css.getPropertyValue('--accent-soft').trim();
  chart('frontier-chart').setOption({...baseChart('frontier-chart'),grid:{left:58,right:18,top:30,bottom:56},tooltip:{...baseChart().tooltip,trigger:'item',formatter:p=>`${escape(p.seriesName)}<br>${t('Риск:')} <b>${percent(p.value[0]/100)}</b><br>${t('Доходность:')} <b>${percent(p.value[1]/100)}</b>`},xAxis:{type:'value',name:t('Риск, % / год'),nameLocation:'middle',nameGap:34,axisLabel:{color:baseChart().textStyle.color,formatter:axisPercent},splitLine:{lineStyle:{color:getComputedStyle(document.documentElement).getPropertyValue('--chart-line').trim()}}},yAxis:{type:'value',name:t('Доходность, % / год'),axisLabel:{color:baseChart().textStyle.color,formatter:axisPercent},splitLine:{lineStyle:{color:getComputedStyle(document.documentElement).getPropertyValue('--chart-line').trim()}}},series:[{name:t('Эффективная граница'),type:'line',data:frontier.map(p=>[p.risk*100,p.return*100]),symbol:'none',lineStyle:{color:colors[0],width:3},z:1},...portfolios.map(p=>({name:portfolioName(p),type:'scatter',data:[[p.risk*100,p.return*100]],symbolSize:p.id==='current'?15:12,itemStyle:{color:p.color,borderColor:baseChart().backgroundColor,borderWidth:2},z:3}))]},true);
  renderWeights();
  const useMoney=view==='wealth';
  chart('equity-chart').setOption({...baseChart('equity-chart'),color:portfolios.map(p=>p.color),legend:{top:0,type:'scroll',textStyle:{fontSize:12,color:baseChart().textStyle.color},itemWidth:16,itemHeight:3},tooltip:{...baseChart().tooltip,trigger:'axis',formatter:items=>escape(items[0]?.axisValue??'')+tooltipRows(items,p=>useMoney?money(p.value):percent(p.value/100))},grid:{left:useMoney?90:60,right:25,top:50,bottom:55},xAxis:{type:'category',boundaryGap:false,data:model.dates,axisLabel:{color:baseChart().textStyle.color,formatter:s=>s.slice(0,7),hideOverlap:true},axisLine:{lineStyle:{color:chartLine}}},yAxis:{type:'value',scale:view==='wealth',axisLabel:{color:baseChart().textStyle.color,formatter:v=>useMoney?number(v/1000)+t(' тыс.'):axisPercent(v)+'%'},splitLine:{lineStyle:{color:chartLine}}},dataZoom:[{type:'inside'},{type:'slider',height:15,bottom:5,borderColor:chartLine,fillerColor:accentSoft,handleStyle:{color:accent,borderColor:accent},moveHandleStyle:{color:accent},handleSize:14}],series:portfolios.map(p=>{const s=stat(p);return {name:portfolioName(p),type:'line',data:view==='wealth'?s.wealth.map(v=>v*capital):view==='return'?s.wealth.map(v=>(v-1)*100):s.drawdown.map(v=>v*100),symbol:'none',lineStyle:{width:p.id==='current'?3:2},emphasis:{focus:'series'}};})},true);
}
function renderMacroCharts() {
  const macro=macroSeries(data),css=getComputedStyle(document.documentElement),line=css.getPropertyValue('--chart-line').trim();
  const view=$('inflation-view').value;
  const inflation={monthly:macro.monthlyInflation,annual:macro.annualInflation,total:macro.accumulatedInflation}[view];
  const label={monthly:'Инфляция за месяц',annual:'Инфляция год к году',total:'Накопленная инфляция'}[view];
  for(const [id,name,values,isMoney] of [['inflation-chart',label,inflation,false],['m2-chart','М2, млрд ₽',macro.moneySupply,true]]) {
    chart(id).setOption({...baseChart(id),aria:{enabled:true,label:{description:t(name)}},grid:{left:isMoney?85:58,right:20,top:25,bottom:60},tooltip:{...baseChart(id).tooltip,trigger:'axis',formatter:items=>escape(items[0]?.axisValue??'')+tooltipRows(items,p=>p.value===null?t('Недостаточно истории'):isMoney?number(p.value)+' '+t('млрд ₽'):percent(p.value/100))},xAxis:{type:'category',boundaryGap:false,data:macro.dates,axisLabel:{formatter:date=>date.slice(0,7),hideOverlap:true}},yAxis:{type:'value',scale:isMoney,axisLabel:{formatter:value=>isMoney?number(value):axisPercent(value)+'%'},splitLine:{lineStyle:{color:line}}},dataZoom:[{type:'inside'},{type:'slider',height:15,bottom:5}],series:[{type:'line',name:t(name),symbol:'circle',showSymbol:values.filter(value=>value!==null).length===1,symbolSize:6,connectNulls:false,data:isMoney?values:values.map(value=>value===null?null:value*100),lineStyle:{color:colors[isMoney?1:0],width:3}}]},true);
  }
}
function renderWeights() {
  if(activeTab!=='portfolio')return;
  if(current.settings.constraints?.short||current.weights.some(w=>w< -1e-8)){ $('weights-chart').style.height='350px';chart('weights-chart').resize();chart('weights-chart').setOption({...baseChart('weights-chart'),...signedWeightsOption(indicatorNames(),current.weights,colors,baseChart().textStyle.color)},true);return;}
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
  saved.push({...current,snapshot:{data,model,frontier:optimizer.frontier},compared:true,id,name:current.name,ordinal:sequence,initial:false,color,weights:[...current.weights],visible:true});
  renderComparison();syncReportSelector();renderCharts();message('Портфель «{name}» добавлен. Выберите другой критерий и рассчитайте следующий.',false,{name,portfolioId:id});
  return {id,name};
}
function workbookDownload(book,name){XLSX.writeFile(book,name,{compression:true});}
function exportChart(id) {
  const names={'frontier-chart':t('Эффективная_граница'),'weights-chart':t('Веса_портфелей'),'equity-chart':view==='wealth'?t('Капитал_портфелей'):view==='return'?t('Доходность_портфелей'):t('Просадки_портфелей')};
  const reportNames={'report-frontier-chart':'Эффективная_граница','report-return-chart':'Доходность_портфелей','report-weights-chart':'Веса_портфелей','report-capital-chart':'Капитал_портфелей','report-drawdown-chart':'Просадки_портфелей','report-recovery-chart':'Восстановление_портфеля','report-comparison-chart':'Сравнение_портфелей','inflation-chart':'Инфляция','m2-chart':'Денежная_масса_М2'};
  const instance=charts[id]||getReportChart(id),filename=names[id]||t(reportNames[id]);
  if(!instance||!filename)throw Error('Сначала рассчитайте портфель.');
  const link=document.createElement('a');
  link.href=instance.getDataURL({type:'svg'});link.download=filename+'.svg';
  document.body.append(link);link.click();link.remove();
  message('Рисунок сохранён в SVG. Его можно вставить в отчёт или презентацию.');
}
function setReady(ready) {
  document.querySelectorAll('[data-requires-data]').forEach(element=>element.disabled=!ready||(element.id==='backtest-run-button'&&data.rows.length<25));
  $('export-button').disabled=!ready||!comparisonPortfolios().length;
  $('report-portfolio').disabled=!ready;
}
function applyDataset(next) {
  if(next.demo!==false||next.official!==true)throw Error('Допускаются только данные официальных источников.');
  const old={data,model,optimizer,current,saved,signature,capital,rf,comparisonPeriod};
  const fields=Object.fromEntries(['mode','lambda','rf','capital'].map(id=>[id,$(id).value]));
  try {
    data=next;signature='';model=null;saved=[];comparisonPeriod=null;
    $('mode').value='markowitz';$('lambda').value='3';modeFields();calculate({quiet:true});
  } catch(error) {
    ({data,model,optimizer,current,saved,signature,capital,rf,comparisonPeriod}=old);
    for(const [id,value] of Object.entries(fields))$(id).value=value;
    modeFields();setReady(!!current);throw error;
  }
  lastMessage=null;$('message').hidden=true;
}
function exportResults() {
  const book=XLSX.utils.book_new(),ps=comparisonPortfolios().map(p=>reportPortfolio(p,comparisonContext(),comparisonPeriod));
  if(!ps.length)throw Error('Сначала рассчитайте портфель.');
  const portfolioModels=ps.map(p=>p.snapshot?.model||model),names=ps.map(p=>p.snapshot?.model.names.map(name=>t(name))||indicatorNames());
  const weightNames=[...new Set(names.flat())],dates=[...new Set(portfolioModels.flatMap(m=>m.dates))].sort();
  const summary=[[t('Портфель'),t('Ожидаемая доходность / год'),t('Волатильность / год'),t('Шарп'),'CAGR',t('Историческая доходность'),t('Макс. просадка'),t('Макс. завершённое восстановление, дни'),t('Текущее восстановление, дни'),t('Ожидаемый реальный доход, ₽'),t('Макс. период восстановления, дни'),t('Максимальное восстановление незавершено')]];
  ps.forEach(p=>{const s=stat(p);summary.push([portfolioName(p),s.expectedReturn,s.risk,s.sharpe,s.cagr,s.totalReturn,s.maxDrawdown,s.longestRecovery,s.openRecovery,s.expectedIncome,s.maxRecovery,s.recoveryIncomplete?t('Да'):t('Нет')]);});
  const add=(rows,name)=>XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),name);
  add(summary,t('Показатели'));add([[t('Индикатор'),...ps.map(p=>portfolioName(p))],...weightNames.map(name=>[name,...ps.map((p,i)=>{const index=names[i].indexOf(name);return index<0?0:p.weights[index];})])],t('Веса'));
  const stats=ps.map(p=>calculateComparisonStat(p,comparisonContext(),comparisonPeriod)),dateIndexes=portfolioModels.map(m=>new Map(m.dates.map((date,i)=>[date,i])));
  add([[t('Дата'),...ps.map(p=>portfolioName(p))],...dates.map(date=>[date,...stats.map((s,i)=>{const index=dateIndexes[i].get(date);return index===undefined?null:s.wealth[index]*capital;})])],t('Реальный капитал'));
  add([[t('Дата'),...ps.map(p=>portfolioName(p))],...dates.map(date=>[date,...stats.map((s,i)=>{const index=dateIndexes[i].get(date);return index===undefined?null:s.drawdown[index];})])],t('Просадки'));
  add([[t('Портфель'),'Long exposure','Short exposure','Net exposure','Gross exposure',t('Максимальная валовая экспозиция, %'),t('Максимальная суммарная короткая позиция, %')],...ps.map(p=>{const e=exposures(p.weights),limits=exposureLimits(p.settings.constraints);return [portfolioName(p),e.long,e.short,e.net,e.gross,limits.grossLimit*100,limits.shortLimit*100];})],t('Экспозиции'));
  add([[t('Риск / год'),t('Ожид. доходность / год'),...indicatorNames()],...optimizer.frontier.map(p=>[p.risk,p.return,...p.weights])],t('Эффективная граница'));
  add([[t('Источник'),t('Ссылка'),t('Методика')],...(data.provenance||[]).map(source=>[t(source.name),source.url,t(source.method)])],t('Источники'));
  add([[t('Дата'),t('ИПЦ'),...data.names.map(n=>t(n))],...data.rows.map(r=>[r.date,r.cpi,...r.values])],t('Исходные данные'));
  add([[t('Дата'),...indicatorNames()],...model.returns.map((r,i)=>[model.dates[i+1],...r])],t('Реальные доходности'));
  const macro=macroSeries(data);
  add([[t('Дата'),t('Накопленная инфляция'),t('Инфляция за месяц'),t('Инфляция год к году'),t('М2, млрд ₽')],...macro.dates.map((date,i)=>[date,macro.accumulatedInflation[i],macro.monthlyInflation[i],macro.annualInflation[i],macro.moneySupply[i]])],t('Инфляция и М2'));
  add([[t('Параметр'),t('Значение')],[t('Источник'),t(data.source)],[t('Периодов в год'),model.frequency],[t('Начальный капитал, ₽'),capital],[t('Номинальная ставка'),current.settings.nominalRf],[t('Реальная безрисковая ставка'),rf],[t('Годовая инфляция'),model.inflation],[t('М2'),t('Макропоказатель; исключён из инвестиционных весов')],[t('Формула доходности'),t('(P_t/P_(t-1))/(ИПЦ_t/ИПЦ_(t-1))-1')],[t('Ожидаемая доходность'),t('Частота × средняя периодическая доходность')],[t('Ковариация'),model.covariance],[t('Сжатие OAS'),model.shrinkage],[t('Ограничения весов'),JSON.stringify(current.settings.constraints)],[t('Ребалансировка'),t('Каждый период, без комиссий и налогов')],[t('Проверка прогноза'),t('Кривая построена на обучающей выборке; вневыборочной проверки нет')],...ps.map(p=>[t('Критерий: ')+portfolioName(p),JSON.stringify(p.settings)])],t('Методика'));
  XLSX.utils.sheet_add_aoa(book.Sheets[t('Методика')],[[t('Период сравнения'),comparisonPeriod?comparisonPeriod.from+' — '+comparisonPeriod.to:t('Вся история')],[t('Базовый портфель'),portfolioName(comparisonPortfolios().find(p=>p.id===baselineId)||current)]],{origin:-1});
  ps.filter(p=>p.snapshot).forEach((p,i)=>{
    const {data:source,model:sourceModel,frontier}=p.snapshot,prefix=t('Портфель')+' '+(i+1)+' ';
    add([[t('Дата'),t('ИПЦ'),...source.names.map(name=>t(name))],...source.rows.map(row=>[row.date,row.cpi,...row.values])],prefix+t('Данные'));
    add([[t('Дата'),...sourceModel.names.map(name=>t(name))],...sourceModel.returns.map((row,index)=>[sourceModel.dates[index+1],...row])],prefix+t('Доходности'));
    add([[t('Риск / год'),t('Ожид. доходность / год'),...sourceModel.names.map(name=>t(name))],...frontier.map(point=>[point.risk,point.return,...point.weights])],prefix+t('Граница'));
    const method=book.Sheets[t('Методика')];
    XLSX.utils.sheet_add_aoa(method,[[t('Источник')+': '+portfolioName(p),prefix+t('Данные')],[t('Номинальная ставка')+': '+portfolioName(p),p.settings.nominalRf],[t('Реальная безрисковая ставка')+': '+portfolioName(p),p.settings.rf]],{origin:-1});
  });
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
function indicatorNames() {return model.names.map(name=>t(name));}
function sameCriterion(portfolio,mode,settings) {
  if(portfolio.mode!==mode||portfolio.snapshot&&portfolio.snapshot.model!==model||JSON.stringify(portfolio.settings.constraints)!==JSON.stringify(settings.constraints)||portfolio.settings.covariance!==settings.covariance)return false;
  const key={markowitz:'lambda',sharpe:'rf',risk:'targetReturn',return:'targetRisk'}[mode];
  return Number.isFinite(portfolio.settings[key])&&Math.abs(portfolio.settings[key]-settings[key])<1e-10;
}
function prepareComparison(modesToAdd) {
  if(!current||!optimizer)throw Error('Сначала рассчитайте портфель.');
  return modesToAdd.map(mode=>{
    try {
      const settings={constraints:current.settings.constraints,covariance:current.settings.covariance,rf,nominalRf:current.settings.nominalRf,lambda:mode==='markowitz'?numeric('compare-lambda'):3,targetReturn:mode==='risk'?numeric('compare-target-return')/100:.1,targetRisk:mode==='return'?numeric('compare-target-risk')/100:.2};
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
      const portfolio={...item.solution,snapshot:{data,model,frontier:optimizer.frontier},id:'p'+ordinal,name:modes[item.mode],mode:item.mode,settings:{...item.settings},ordinal,initial:false,color,visible:true,weights:[...item.solution.weights]};
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
  renderReport({model,frontier:optimizer.frontier,portfolios:allPortfolios().map(original=>{const p=reportPortfolio(original,comparisonContext(),original.compared!==false?comparisonPeriod:null);return {...p,displayName:portfolioName(p),indicatorNames:p.snapshot?.model.names.map(name=>t(name))||indicatorNames()};}),stats:stat,indicatorNames:indicatorNames(),colors,selectedId:selectedReportId,capital,comparisonView:reportView});
}
function resizeVisibleCharts() {
  if(activeTab==='portfolio')Object.values(charts).forEach(c=>c.resize());
  if(activeTab==='graphs'){resizeReport();for(const id of ['inflation-chart','m2-chart'])charts[id]?.resize();}
  if(activeTab==='backtest')backtestView?.resize();
}
function activateTab(name,{focus=false,updateHash=true}={}) {
  if(!['portfolio','graphs','comparison','backtest','data','help'].includes(name))return;
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
try{discardGeneratedComparisonSets(localStorage);}catch{/* Browser storage may be unavailable. */}
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

$('position-mode').addEventListener('change',()=>{const short=$('position-mode').value==='short';$('min-weight').min=short?'-100':'0';$('min-weight').value=short?String(-Math.min(30,numeric('max-weight'))):'0';positionFields();});
for(const id of ['gross-limit','short-limit'])$(id).addEventListener('input',positionFields);
function changeAssets(next){
  const previous=excludedAssets;excludedAssets=next;
  try{calculate({quiet:true});$('asset-selection-status').textContent=t('Активы обновлены. Текущий портфель пересчитан.');}
  catch(error){excludedAssets=previous;render();$('asset-selection-status').textContent=translateError(error.message);}
}
$('asset-toggles').addEventListener('change',event=>{if(event.target.dataset.asset===undefined)return;const index=Number(event.target.dataset.asset);changeAssets(event.target.checked?excludedAssets.filter(i=>i!==index):[...excludedAssets,index].sort((a,b)=>a-b));});
$('include-all-assets').addEventListener('click',()=>changeAssets([]));
$('mode').addEventListener('change',modeFields);
$('optimization-form').addEventListener('submit',guarded(async e=>{e.preventDefault();$('calculate-button').disabled=true;$('save-button').disabled=true;try{await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));calculate();}finally{$('calculate-button').disabled=!current;$('save-button').disabled=!current;}}));
$('save-button').addEventListener('click',guarded(savePortfolio));
$('compare-all-button').addEventListener('click',()=>addCriteriaToComparison(['markowitz','sharpe','risk','return']));
document.querySelectorAll('[data-add-criterion]').forEach(button=>button.addEventListener('click',()=>addCriteriaToComparison([button.dataset.addCriterion])));
$('export-button').addEventListener('click',guarded(exportResults));
document.querySelectorAll('[data-download]').forEach(button=>button.addEventListener('click',guarded(()=>exportChart(button.dataset.download))));
$('comparison-cards').addEventListener('change',e=>{const p=allPortfolios().find(p=>p.id===e.target.dataset.toggle);if(p){p.visible=e.target.checked;renderCharts();}});
$('comparison-cards').addEventListener('click',e=>{const id=e.target.dataset.remove;if(id){if(id==='current')current.compared=false;else saved=saved.filter(p=>p.id!==id);renderComparison();syncReportSelector();renderCharts();message('Портфель убран из сравнения.');}});
$('weights-view').addEventListener('change',renderWeights);
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{view=b.dataset.view;document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('active',x===b));renderCharts();}));
$('report-portfolio').addEventListener('change',()=>{selectedReportId=$('report-portfolio').value;renderReportFigures();});
$('inflation-view').addEventListener('change',()=>{if(current&&activeTab==='graphs')renderMacroCharts();});
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
  if(button.dataset.scrollTarget)requestAnimationFrame(()=>$(button.dataset.scrollTarget)?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'}));
}));
window.addEventListener('hashchange',()=>activateTab(location.hash.slice(1),{updateHash:false}));
$('method-button').addEventListener('click',()=>$('method-dialog').showModal());
$('close-method').addEventListener('click',()=>$('method-dialog').close());
$('method-dialog').addEventListener('click',e=>{if(e.target===$('method-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
new ResizeObserver(resizeVisibleCharts).observe(document.querySelector('.app-main'));
backtestView=createBacktestView(()=>current?{data,frequency:model.frequency,capital,nominalRf:current.settings.nominalRf,constraints:current.settings.constraints,covariance:current.settings.covariance}:null);
importView=createDataImportView({applyDataset,onUnavailable:()=>{if(!current){$('data-status').textContent=t('Нет данных');$('data-badge').textContent=t('Нет данных');setReady(false);message('Статистика недоступна. Откройте «Данные» и повторите загрузку.',true);}}});
comparisonControls=createComparisonControls({getState:comparisonState,onPeriod:setComparisonPeriod,onRestore:restoreComparisonState,onBaseline:id=>{baselineId=id;renderComparison();},onHighlight:value=>{highlightComparison=value;renderComparison();},portfolioName,message});
modeFields();setReady(false);
activateTab(location.hash.slice(1)||'portfolio',{updateHash:false});
try {
  if(!window.echarts||!window.XLSX)throw Error(t('Не загрузились библиотеки графиков или Excel. Перезапустите приложение.'));
  await importView.initialize();
}catch(e){message(e.message,true);}
activateTab(location.hash.slice(1)||'portfolio',{updateHash:false});
document.fonts.ready.then(()=>requestAnimationFrame(()=>{if(current){resizeVisibleCharts();renderCharts();}}));
