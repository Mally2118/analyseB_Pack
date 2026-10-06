import {parseTable,estimate,createOptimizer,metrics} from './engine.js';

export const comparisonMetrics=[
  ['expectedIncome',1,'money'],['expectedReturn',1,'percent'],['risk',-1,'percent'],['sharpe',1,'number'],
  ['cagr',1,'percent'],['totalReturn',1,'percent'],['maxDrawdown',1,'percent'],
  ['maxRecovery',-1,'days'],['longestRecovery',-1,'days'],['openRecovery',-1,'days']
];
const periodCache=new WeakMap();
const libraryKey='portfolio-lab.comparison-sets.v1';

export function commonDates(portfolios,context) {
  if(!portfolios.length)return [];
  const dates=portfolios.map(p=>p.snapshot?.model.dates||context.model.dates);
  const others=dates.slice(1).map(list=>new Set(list));
  return dates[0].filter(date=>others.every(set=>set.has(date)));
}

export function evaluatePortfolio(portfolio,context,period=null) {
  const source=portfolio.snapshot?.data||context.data;
  const sourceModel=portfolio.snapshot?.model||context.model;
  if(!period)return {portfolio,model:sourceModel,rf:portfolio.snapshot?portfolio.settings.rf:context.rf};
  const dates=sourceModel.dates;
  if(!dates.includes(period.from)||!dates.includes(period.to)||period.from>=period.to)throw Error('Выберите начальную и конечную даты, доступные всем портфелям.');
  const rows=source.rows.filter(row=>row.date>=period.from&&row.date<=period.to);
  if(rows.length<13)throw Error('В общем периоде нужно минимум 13 наблюдений для каждого портфеля.');
  const cash=sourceModel.names[0]!==source.names[0],key=`${sourceModel.frequency}:${cash}:${period.from}:${period.to}`;
  let cache=periodCache.get(source);if(!cache){cache=new Map();periodCache.set(source,cache);}
  let snapshot=cache.get(key);
  if(!snapshot){const data={...source,rows},model=estimate(data,sourceModel.frequency,cash);snapshot={data,model};cache.set(key,snapshot);}
  const nominalRf=portfolio.snapshot?portfolio.settings.nominalRf:context.nominalRf;
  const rf=(1+nominalRf)/(1+snapshot.model.inflation)-1;
  return {portfolio:{...portfolio,settings:{...portfolio.settings,rf},snapshot},model:snapshot.model,rf};
}

export function comparisonStat(portfolio,context,period=null) {
  const result=evaluatePortfolio(portfolio,context,period);
  return metrics(result.model,portfolio.weights,result.rf,context.capital);
}

export function reportPortfolio(portfolio,context,period=null) {
  const result=evaluatePortfolio(portfolio,context,period);
  if(period&&!result.portfolio.snapshot.frontier)result.portfolio.snapshot.frontier=createOptimizer(result.model).frontier;
  return result.portfolio;
}

export function metricComparison(stats,key,direction) {
  // An ongoing recovery is a lower bound, so ranking its final duration or
  // subtracting it from a completed recovery would imply false precision.
  if(key==='openRecovery'||key==='maxRecovery'&&stats.some(stat=>stat.recoveryIncomplete))return {best:[],worst:[],comparable:false};
  const values=stats.map(stat=>stat[key]).filter(Number.isFinite);
  if(values.length<2)return {best:[],worst:[],comparable:true};
  const low=Math.min(...values),high=Math.max(...values),epsilon=1e-10*Math.max(1,Math.abs(low),Math.abs(high));
  if(high-low<=epsilon)return {best:[],worst:[],comparable:true};
  const best=direction>0?high:low,worst=direction>0?low:high;
  return {best:stats.flatMap((stat,i)=>Number.isFinite(stat[key])&&Math.abs(stat[key]-best)<=epsilon?[i]:[]),worst:stats.flatMap((stat,i)=>Number.isFinite(stat[key])&&Math.abs(stat[key]-worst)<=epsilon?[i]:[]),comparable:true};
}

export function serializeComparison(state) {
  const sources=[],sourceIndex=new Map();
  function pack(portfolio){
    const data=portfolio.snapshot?.data||state.data;
    if(!sourceIndex.has(data)){sourceIndex.set(data,sources.length);sources.push(data);}
    const model=portfolio.snapshot?.model||state.model;
    return {id:portfolio.id,name:portfolio.name,mode:portfolio.mode,weights:[...portfolio.weights],settings:{...portfolio.settings},ordinal:portfolio.ordinal,initial:portfolio.initial,profile:portfolio.profile,visible:portfolio.visible,compared:portfolio.compared,snapshot:!!portfolio.snapshot,source:sourceIndex.get(data),frequency:model.frequency,cash:model.names[0]!==data.names[0]};
  }
  const current=pack(state.current),saved=state.saved.map(pack);
  return {version:1,sources,current,saved,capital:state.capital,sequence:state.sequence,period:state.period,baselineId:state.baselineId,selectedReportId:state.selectedReportId,reportView:state.reportView,highlight:state.highlight};
}

export function restoreComparison(payload) {
  const invalid=()=>{throw Error('Сохранённый набор повреждён. Текущее сравнение сохранено.');};
  if(payload?.version!==1||!Array.isArray(payload.sources)||payload.sources.length<1||payload.sources.length>9||!Array.isArray(payload.saved)||payload.saved.length>8||!Number.isFinite(payload.capital)||payload.capital<=0||payload.capital>1e15)invalid();
  const sources=payload.sources.map(source=>{
    if(!source||!Array.isArray(source.names)||!Array.isArray(source.rows)||source.rows.length>5000||typeof source.source!=='string')invalid();
    const parsed=parseTable([['Дата','ИПЦ',...source.names],...source.rows.map(row=>[row.date,row.cpi,...row.values])]);
    return {...parsed,source:source.source,demo:source.demo===true,official:source.official===true};
  });
  const contexts=new Map(),ids=new Set();
  function unpack(portfolio){
    if(!portfolio||!/^current$|^p\d+$/.test(portfolio.id)||ids.has(portfolio.id)||!['markowitz','sharpe','risk','return'].includes(portfolio.mode)||!Array.isArray(portfolio.weights)||portfolio.weights.length!==10||portfolio.weights.some(w=>!Number.isFinite(w)||w<0)||Math.abs(portfolio.weights.reduce((a,b)=>a+b,0)-1)>1e-7||!Number.isInteger(portfolio.source)||!sources[portfolio.source]||![1,12,252].includes(portfolio.frequency)||typeof portfolio.cash!=='boolean'||typeof portfolio.name!=='string'||portfolio.name.length>160)invalid();
    if(!portfolio.settings||Object.values(portfolio.settings).some(value=>!Number.isFinite(value))||!Number.isFinite(portfolio.settings.nominalRf)||portfolio.settings.nominalRf<=-1)invalid();
    if(portfolio.profile&&!['m2-90-67','m2-60-67'].includes(portfolio.profile))invalid();
    if(portfolio.ordinal!==undefined&&(!Number.isInteger(portfolio.ordinal)||portfolio.ordinal<1))invalid();
    ids.add(portfolio.id);
    const key=`${portfolio.source}:${portfolio.frequency}:${portfolio.cash}`;
    if(!contexts.has(key)){const data=sources[portfolio.source],model=estimate(data,portfolio.frequency,portfolio.cash),optimizer=createOptimizer(model);contexts.set(key,{data,model,optimizer,frontier:optimizer.frontier});}
    const context=contexts.get(key),rf=(1+portfolio.settings.nominalRf)/(1+context.model.inflation)-1;
    const restored={...portfolio,weights:[...portfolio.weights],settings:{...portfolio.settings,rf},visible:portfolio.visible!==false,compared:portfolio.compared!==false};
    delete restored.source;delete restored.frequency;delete restored.cash;delete restored.snapshot;
    if(portfolio.snapshot)restored.snapshot={data:context.data,model:context.model,frontier:context.frontier};
    metrics(context.model,restored.weights,rf,payload.capital);
    return {portfolio:restored,context};
  }
  const main=unpack(payload.current);if(main.portfolio.id!=='current'||main.portfolio.snapshot)invalid();
  const saved=payload.saved.map(p=>{
    const result=unpack(p);if(result.portfolio.id==='current'||!p.snapshot&&(result.context!==main.context))invalid();
    return result.portfolio;
  });
  if(!Number.isInteger(payload.sequence)||payload.sequence<Math.max(0,...saved.map(p=>Number(p.id.slice(1))),...saved.map(p=>p.ordinal||0)))invalid();
  const period=payload.period??null;
  if(period&&(typeof period.from!=='string'||typeof period.to!=='string'))invalid();
  const context={...main.context,capital:payload.capital,nominalRf:main.portfolio.settings.nominalRf,rf:main.portfolio.settings.rf};
  const portfolios=[main.portfolio,...saved].filter(p=>p.compared!==false);
  if(period)portfolios.forEach(p=>comparisonStat(p,context,period));
  return {...context,current:main.portfolio,saved,sequence:payload.sequence,period,baselineId:ids.has(payload.baselineId)?payload.baselineId:'current',selectedReportId:ids.has(payload.selectedReportId)?payload.selectedReportId:'current',reportView:['return','wealth','drawdown','recovery','frontier','weights'].includes(payload.reportView)?payload.reportView:'return',signature:`${main.context.model.frequency}:${payload.current.cash}`,highlight:payload.highlight!==false};
}

export function readComparisonSets(storage) {
  const raw=storage.getItem(libraryKey);if(!raw)return [];
  const entries=JSON.parse(raw);
  if(!Array.isArray(entries)||entries.length>10||entries.some(entry=>!entry||typeof entry.id!=='string'||typeof entry.name!=='string'||!entry.name.trim()||entry.name.length>80||typeof entry.date!=='string'||!Number.isFinite(Date.parse(entry.date))||entry.payload?.version!==1))throw Error('Не удалось прочитать сохранённые наборы.');
  return entries;
}

export function saveComparisonSet(storage,entries,name,payload) {
  name=name.trim();if(!name||name.length>80)throw Error('Введите название набора: от 1 до 80 символов.');
  const existing=entries.find(entry=>entry.name===name);
  if(!existing&&entries.length>=10)throw Error('Можно хранить до 10 наборов. Удалите один, чтобы сохранить новый.');
  const date=new Date().toISOString(),entry={id:existing?.id||globalThis.crypto.randomUUID(),name,date,payload};
  const next=existing?entries.map(item=>item.id===entry.id?entry:item):[...entries,entry];
  storage.setItem(libraryKey,JSON.stringify(next));
  return {entries:next,id:entry.id};
}

export function deleteComparisonSet(storage,entries,id) {
  const next=entries.filter(entry=>entry.id!==id);storage.setItem(libraryKey,JSON.stringify(next));return next;
}
