import {t,locale} from './i18n.js';

// Figures in the report always use one portfolio. Only its final chart compares
// visible portfolios. Statistics come from the app's existing calculation.
const charts=new Map();
let lastReport;
const $=id=>document.getElementById(id);
const percent=value=>Number.isFinite(value)?new Intl.NumberFormat(locale(),{style:'percent',minimumFractionDigits:2,maximumFractionDigits:2}).format(value):'—';
const number=value=>Number.isFinite(value)?new Intl.NumberFormat(locale(),{maximumFractionDigits:0}).format(value):'—';
const money=value=>number(value)+' ₽';
const axisNumber=value=>new Intl.NumberFormat(locale(),{maximumSignificantDigits:3}).format(value);
const compactMoney=value=>new Intl.NumberFormat(locale(),{notation:'compact',maximumFractionDigits:1}).format(value);
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const nameOf=portfolio=>portfolio.displayName??portfolio.name??t('Портфель');
const labels={
  'report-frontier-chart':'Эффективная граница',
  'report-return-chart':'Кривая доходности портфеля',
  'report-weights-chart':'Структура портфеля',
  'report-capital-chart':'Реальный капитал',
  'report-drawdown-chart':'Максимальная просадка',
  'report-recovery-chart':'Восстановление после просадок',
  'report-comparison-chart':'Сравнение портфелей'
};

function visible(element){return !!element&&element.clientWidth>0&&element.clientHeight>0&&element.getClientRects().length>0;}
function palette(){
  const css=getComputedStyle(document.documentElement);
  const value=(key,fallback)=>css.getPropertyValue(key).trim()||fallback;
  return {surface:value('--surface','#fbf9f4'),text:value('--text','#22211d'),muted:value('--muted','#706a5e'),line:value('--chart-line','#ded9cf'),accent:value('--accent','#d9481f'),soft:value('--accent-soft','rgba(217,72,31,.12)')};
}
function base(id,p){
  return {
    animation:!matchMedia('(prefers-reduced-motion: reduce)').matches,
    animationDuration:300,
    textStyle:{fontFamily:'IBM Plex Sans, Arial, sans-serif',color:p.muted,fontSize:12},
    backgroundColor:p.surface,
    aria:{enabled:true,label:{description:t(labels[id]||'Графики выбранного портфеля')}},
    tooltip:{backgroundColor:p.surface,borderColor:p.line,textStyle:{color:p.text},confine:true},
    color:lastReport.colors
  };
}
function draw(id,option){
  const element=$(id);
  if(!visible(element)||!globalThis.echarts)return;
  let instance=charts.get(id);
  if(!instance){instance=globalThis.echarts.init(element,null,{renderer:'svg'});charts.set(id,instance);}
  instance.setOption(option,true);
}
function statFor(portfolio,args){
  if(typeof args.stats==='function')return args.stats(portfolio);
  if(args.stats instanceof Map)return args.stats.get(portfolio.id)??args.stats.get(portfolio);
  return args.stats?.[portfolio.id];
}
function setText(id,text){const element=$(id);if(element)element.textContent=text;}
function recoveryText(stat){return (stat.recoveryIncomplete?'≥ ':'')+number(stat.maxRecovery)+' '+t('дн.');}
function recoverySeries(stat,dates){
  let peak=1,peakIndex=0;
  return stat.wealth.map((value,index)=>{
    if(value>=peak*(1-1e-12)){peak=value;peakIndex=index;return 0;}
    return Math.max(0,(Date.parse(dates[index])-Date.parse(dates[peakIndex]))/86400000);
  });
}
function modelFor(portfolio,args){return portfolio.snapshot?.model||args.model;}
function namesFor(portfolio,args){return portfolio.indicatorNames||args.indicatorNames;}
function seriesValues(stat,view,args){
  if(view==='wealth')return stat.wealth.map(value=>value*args.capital);
  if(view==='drawdown')return stat.drawdown.map(value=>value*100);
  if(view==='recovery')return recoverySeries(stat,args.model.dates);
  return stat.wealth.map(value=>(value-1)*100);
}
function viewTitle(view){
  return t(view==='wealth'?'Капитал, ₽':view==='drawdown'?'Просадка, %':view==='recovery'?'Восстановление, дни':'Доходность, %');
}
function viewValue(value,view){return view==='wealth'?money(value):view==='recovery'?number(value)+' '+t('дн.'):percent(value/100);}
function timeOption(id,view,portfolios,args,p,comparison=false){
  const narrow=($(id)?.clientWidth||600)<420;
  const dates=comparison?[...new Set(portfolios.flatMap(portfolio=>modelFor(portfolio,args).dates))].sort():args.model.dates;
  const valueLabel=value=>view==='wealth'?compactMoney(value):view==='recovery'?number(value):axisNumber(value)+'%';
  const zeroLine={symbol:['none','none'],silent:true,label:{show:false},lineStyle:{color:p.line,width:1,type:'solid'},data:[{yAxis:0}]};
  return {...base(id,p),
    legend:comparison?{type:'scroll',top:2,textStyle:{color:p.muted,fontSize:11},itemHeight:3,itemWidth:16}:undefined,
    tooltip:{...base(id,p).tooltip,trigger:'axis',axisPointer:{type:'line',lineStyle:{color:p.muted,type:'dashed'}},formatter:items=>{
      const rows=Array.isArray(items)?items:[items];
      return `<strong>${escape(rows[0]?.axisValue??'')}</strong>`+rows.map(item=>`<div style="margin-top:6px"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${escape(item.color)};margin-right:7px"></span>${escape(item.seriesName)} <b>${escape(viewValue(item.value,view))}</b></div>`).join('');
    }},
    grid:{left:narrow?47:view==='wealth'?78:64,right:narrow?12:22,top:comparison?47:narrow?20:38,bottom:64},
    xAxis:{type:'category',boundaryGap:false,data:dates,axisLabel:{color:p.muted,fontSize:narrow?10:11,hideOverlap:true,formatter:value=>String(value).slice(0,7)},axisLine:{lineStyle:{color:p.line}},axisTick:{show:false}},
    yAxis:{type:'value',name:narrow?'':viewTitle(view),nameTextStyle:{color:p.muted,fontSize:11,align:'left'},scale:view==='wealth',min:view==='recovery'?0:undefined,axisLabel:{color:p.muted,fontSize:narrow?10:11,formatter:valueLabel},splitLine:{lineStyle:{color:p.line}}},
    dataZoom:[{type:'inside',filterMode:'none'},{type:'slider',height:14,bottom:9,borderColor:p.line,fillerColor:p.soft,handleStyle:{color:p.accent,borderColor:p.accent},moveHandleStyle:{color:p.accent},handleSize:13,showDetail:false}],
    series:portfolios.map(portfolio=>{
      const stat=statFor(portfolio,args),color=portfolio.color||p.accent;
      const sourceModel=modelFor(portfolio,args),values=seriesValues(stat,view,{...args,model:sourceModel});
      const byDate=new Map(sourceModel.dates.map((date,index)=>[date,values[index]]));
      return {name:nameOf(portfolio),type:'line',data:dates.map(date=>byDate.get(date)??null),symbol:'none',connectNulls:false,
        lineStyle:{color,width:comparison?portfolio.id==='current'?3:2:2.5},itemStyle:{color},
        areaStyle:comparison?undefined:{color,opacity:view==='drawdown'?.13:view==='recovery'?.10:.04},
        emphasis:{focus:'series'},markLine:!comparison&&view!=='wealth'?zeroLine:undefined};
    })};
}
function frontierOption(id,portfolios,args,p,comparison=false){
  const frontiers=new Map();
  for(const portfolio of portfolios) {
    const sourceModel=modelFor(portfolio,args);
    if(!frontiers.has(sourceModel))frontiers.set(sourceModel,{points:portfolio.snapshot?.frontier||args.frontier,name:t('Эффективная граница')+(comparison&&portfolio.snapshot?' · '+nameOf(portfolio):''),color:comparison?(portfolio.snapshot?portfolio.color:p.muted):p.accent});
  }
  const narrow=($(id)?.clientWidth||600)<420;
  return {...base(id,p),
    legend:comparison?{type:'scroll',top:0,textStyle:{color:p.muted,fontSize:11},itemWidth:15,itemHeight:8}:undefined,
    grid:{left:narrow?49:64,right:narrow?18:26,top:comparison?48:38,bottom:57},
    tooltip:{...base(id,p).tooltip,trigger:'item',formatter:item=>`${escape(item.seriesName)}<br>${escape(t('Риск:'))} <b>${escape(percent(item.value[0]/100))}</b><br>${escape(t('Доходность:'))} <b>${escape(percent(item.value[1]/100))}</b>`},
    xAxis:{type:'value',name:t('Риск, % / год'),nameLocation:'middle',nameGap:35,nameTextStyle:{fontSize:narrow?10:11,color:p.muted},axisLabel:{color:p.muted,fontSize:narrow?10:11,formatter:axisNumber},splitLine:{lineStyle:{color:p.line}}},
    yAxis:{type:'value',name:narrow?'':t('Доходность, % / год'),nameTextStyle:{fontSize:11,color:p.muted,align:'left'},axisLabel:{color:p.muted,fontSize:narrow?10:11,formatter:axisNumber},splitLine:{lineStyle:{color:p.line}}},
    series:[...frontiers.values()].map(frontier=>({name:frontier.name,type:'line',data:frontier.points.map(point=>[point.risk*100,point.return*100]),symbol:'none',lineStyle:{color:frontier.color,width:2.5},z:1})).concat(portfolios.map(portfolio=>{const stat=statFor(portfolio,args);return {name:nameOf(portfolio),type:'scatter',data:[[stat.risk*100,stat.expectedReturn*100]],symbolSize:portfolio.id==='current'?15:12,itemStyle:{color:portfolio.color||p.accent,borderColor:p.surface,borderWidth:2},z:3};}))
  };
}
function weightsOption(args,portfolio,p){
  const id='report-weights-chart',narrow=($(id)?.clientWidth||600)<420;
  return {...base(id,p),
    tooltip:{...base(id,p).tooltip,trigger:'item',formatter:item=>`${escape(item.name)}<br><b>${escape(percent(item.value/100))}</b>`},
    legend:{type:'scroll',bottom:0,textStyle:{fontSize:narrow?10:11,color:p.muted},itemHeight:9,itemWidth:9},
    graphic:[{type:'text',left:'center',top:'40%',style:{text:'100%',fontFamily:'IBM Plex Mono, monospace',fontSize:narrow?27:31,fontWeight:500,fill:p.text}},{type:'text',left:'center',top:'52%',style:{text:t('капитала'),fontFamily:'IBM Plex Sans, Arial, sans-serif',fontSize:12,fill:p.muted}}],
    series:[{name:nameOf(portfolio),type:'pie',radius:['47%','72%'],center:['50%','44%'],avoidLabelOverlap:true,
      itemStyle:{borderColor:p.surface,borderWidth:3,borderRadius:3},label:{show:false},
      emphasis:{scale:true,scaleSize:5,itemStyle:{shadowBlur:8,shadowColor:'rgba(0,0,0,.12)'}},
      data:args.indicatorNames.map((name,index)=>({name,value:portfolio.weights[index]*100,itemStyle:{color:args.colors[index]}})).filter(item=>item.value>1e-7)}]
  };
}
function weightComparisonOption(args,portfolios,p){
  const id='report-comparison-chart',narrow=($(id)?.clientWidth||600)<420;
  const names=[...new Set(portfolios.flatMap(portfolio=>namesFor(portfolio,args)))];
  return {...base(id,p),
    legend:{type:'scroll',top:0,textStyle:{color:p.muted,fontSize:11},itemHeight:9,itemWidth:9},
    tooltip:{...base(id,p).tooltip,trigger:'axis',axisPointer:{type:'shadow'},formatter:items=>`<strong>${escape(items[0]?.axisValue??'')}</strong>`+items.map(item=>`<div style="margin-top:6px">${escape(item.seriesName)} <b>${escape(percent(item.value/100))}</b></div>`).join('')},
    grid:{left:48,right:16,top:48,bottom:narrow?112:90},
    xAxis:{type:'category',data:names,axisLabel:{color:p.muted,fontSize:narrow?10:11,interval:0,rotate:narrow?55:35,width:narrow?72:120,overflow:'truncate'},axisLine:{lineStyle:{color:p.line}},axisTick:{show:false}},
    yAxis:{type:'value',name:t('Вес, %'),nameTextStyle:{fontSize:11,color:p.muted,align:'left'},axisLabel:{color:p.muted,formatter:value=>axisNumber(value)+'%'},splitLine:{lineStyle:{color:p.line}}},
    series:portfolios.map(portfolio=>({name:nameOf(portfolio),type:'bar',data:names.map(name=>{const index=namesFor(portfolio,args).indexOf(name);return index<0?0:portfolio.weights[index]*100;}),itemStyle:{color:portfolio.color||p.accent,borderRadius:[2,2,0,0]},barMaxWidth:28,emphasis:{focus:'series'}}))
  };
}

export function renderReport(options){
  const args={selectedId:'current',capital:1000000,comparisonView:'return',...options};
  args.indicatorNames=typeof args.indicatorNames==='function'?args.indicatorNames():args.indicatorNames;
  lastReport=args;
  if(!args.model||!args.portfolios?.length)return;
  const selected=args.portfolios.find(portfolio=>portfolio.id===args.selectedId)||args.portfolios[0],stat=statFor(selected,args);
  if(!stat)return;
  const p=palette();
  setText('report-income',money(stat.expectedIncome));
  setText('report-rate',percent(stat.expectedReturn)+' '+t('реальной доходности / год'));
  setText('report-risk',percent(stat.risk));
  setText('report-drawdown',percent(stat.maxDrawdown));
  setText('report-recovery',recoveryText(stat));
  setText('report-recovery-note',stat.recoveryIncomplete?t('Возврат к пику ещё не произошёл'):stat.openRecovery?t('Текущее восстановление:')+' '+number(stat.openRecovery)+' '+t('дн.'):t('По завершённым восстановлениям'));
  setText('report-cagr',percent(stat.cagr));
  setText('report-total-return',percent(stat.totalReturn));
  setText('report-sharpe',stat.sharpe===null?t('Не определён'):new Intl.NumberFormat(locale(),{minimumFractionDigits:2,maximumFractionDigits:2}).format(stat.sharpe));
  setText('report-final-capital',money(stat.finalCapital));
  const selectedArgs={...args,model:modelFor(selected,args),frontier:selected.snapshot?.frontier||args.frontier,indicatorNames:namesFor(selected,args)};
  draw('report-frontier-chart',frontierOption('report-frontier-chart',[selected],selectedArgs,p));
  draw('report-return-chart',timeOption('report-return-chart','return',[selected],selectedArgs,p));
  draw('report-weights-chart',weightsOption(selectedArgs,selected,p));
  draw('report-capital-chart',timeOption('report-capital-chart','wealth',[selected],selectedArgs,p));
  draw('report-drawdown-chart',timeOption('report-drawdown-chart','drawdown',[selected],selectedArgs,p));
  draw('report-recovery-chart',timeOption('report-recovery-chart','recovery',[selected],selectedArgs,p));
  const visiblePortfolios=args.portfolios.filter(portfolio=>portfolio.compared!==false&&portfolio.visible!==false&&statFor(portfolio,args));
  const view=args.comparisonView;
  const comparison=view==='frontier'?frontierOption('report-comparison-chart',visiblePortfolios,args,p,true):view==='weights'?weightComparisonOption(args,visiblePortfolios,p):timeOption('report-comparison-chart',view,visiblePortfolios,args,p,true);
  draw('report-comparison-chart',comparison);
}

export function resizeReport(){
  for(const [id,instance] of charts)if(visible($(id)))instance.resize();
  if(lastReport)renderReport(lastReport);
}
export function getReportChart(id){return charts.get(id);}
export function exportReportChart(id){
  const instance=charts.get(id);
  if(!instance)throw Error(t('Сначала рассчитайте портфель.'));
  const link=document.createElement('a');
  link.href=instance.getDataURL({type:'svg'});
  link.download=t(labels[id]||'Графики выбранного портфеля').replace(/\s+/g,'_')+'.svg';
  document.body.append(link);link.click();link.remove();
}
