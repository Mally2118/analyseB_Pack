import {runBacktest} from './backtest.js';
import {t,locale,translateError} from './i18n.js';

const $=id=>document.getElementById(id);
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const percent=value=>Number.isFinite(value)?new Intl.NumberFormat(locale(),{style:'percent',minimumFractionDigits:2,maximumFractionDigits:2}).format(value):'—';
const number=value=>new Intl.NumberFormat(locale(),{maximumFractionDigits:0}).format(value);
const money=value=>number(value)+' ₽';
const modes={markowitz:'Марковиц',sharpe:'Максимум Шарпа',risk:'Эффективный риск',return:'Эффективная доходность',equal:'Равные доли — по 10%'};
const labels={'backtest-return-chart':'Доходность на проверке','backtest-drawdown-chart':'Просадки на проверке','backtest-weights-chart':'Веса, рассчитанные на обучении'};

export function createBacktestView(getState) {
  let result=null,lastState=null,lastStatus=null;
  const charts=new Map();
  const inputLabels=new Map(['backtest-lambda','backtest-target-return','backtest-target-risk'].map(id=>[id,$(id).labels[0].textContent]));
  function status(key,error=false,values={}) {
    lastStatus={key,error,values};
    $('backtest-status').textContent=error?translateError(key):t(key,values);
    $('backtest-status').classList.toggle('error',error);$('backtest-status').hidden=false;
  }
  function numeric(id) {
    const value=$(id).value.trim();
    if(!value||!Number.isFinite(Number(value)))throw Error('Заполните числовой параметр: '+inputLabels.get(id));
    return Number(value);
  }
  function sync() {
    const state=getState();if(!state?.data)return;
    const changed=!lastState||['data','frequency','cash','capital','nominalRf'].some(key=>state[key]!==lastState[key]);
    if(changed) {
      result=null;$('backtest-results').hidden=true;$('backtest-table').querySelector('tbody').replaceChildren();$('backtest-export-button').disabled=true;lastStatus=null;$('backtest-status').hidden=true;
      const rows=state.data.rows,ready=rows.length>=25;
      $('backtest-run-button').disabled=!ready;$('backtest-split').disabled=!ready;
      if(ready) {
        const index=Math.max(12,Math.min(rows.length-13,Math.floor((rows.length-1)*.7)));
        $('backtest-split').min=rows[12].date;$('backtest-split').max=rows[rows.length-13].date;
        $('backtest-split').value=rows[index].date;
      } else {$('backtest-split').value='';status('Для проверки нужно минимум 25 наблюдений: по 12 периодов на обучение и проверку.',true);}
      lastState={...state};
    }
    $('backtest-period-hint').textContent=t('Минимум 12 периодов в каждой части. По умолчанию около 70% данных используются для обучения.');
    $('backtest-context').textContent=t('Общие параметры из последнего расчёта: {capital}, ставка {rate}, {frequency}.',{
      capital:money(state.capital),rate:percent(state.nominalRf),frequency:t({12:'Месячные данные',252:'Дневные данные',1:'Годовые данные'}[state.frequency])
    });
  }
  function name(portfolio) {
    const mode=portfolio.mode,base=t(modes[mode]);
    return mode==='markowitz'?base+' · λ = '+result.settings.lambda:mode==='risk'?base+t(' · цель ')+percent(result.settings.targetReturn):mode==='return'?base+t(' · риск ≤ ')+percent(result.settings.targetRisk):base;
  }
  const portfolios=()=>result?[...result.portfolios,result.benchmark]:[];
  function palette() {
    const css=getComputedStyle(document.documentElement),dark=document.documentElement.dataset.theme==='dark';
    return {surface:css.getPropertyValue('--surface').trim(),muted:css.getPropertyValue('--muted').trim(),text:css.getPropertyValue('--text').trim(),line:css.getPropertyValue('--chart-line').trim(),colors:dark?['#ff6a3d','#92b4df','#d8bd74','#8fc8c0','#d0c5b4']:['#d9481f','#55759b','#a68e4b','#5e9791','#514c43']};
  }
  function draw(id,option) {
    const element=$(id);if(!element.clientWidth||!element.getClientRects().length)return;
    let chart=charts.get(id);if(!chart){chart=echarts.init(element,null,{renderer:'svg'});charts.set(id,chart);}
    chart.setOption(option,true);
  }
  function renderCharts() {
    if(!result||$('panel-backtest').hidden)return;
    const p=palette(),ps=portfolios(),narrow=$('backtest-return-chart').clientWidth<420;
    const base={backgroundColor:p.surface,color:p.colors,animation:!matchMedia('(prefers-reduced-motion: reduce)').matches,textStyle:{fontFamily:'IBM Plex Sans, Arial, sans-serif',color:p.muted},legend:{type:'scroll',top:0,textStyle:{color:p.muted,fontSize:11}},tooltip:{trigger:'axis',confine:true,backgroundColor:p.surface,borderColor:p.line,textStyle:{color:p.text}},aria:{enabled:true}};
    for(const [id,drawdown] of [['backtest-return-chart',false],['backtest-drawdown-chart',true]]) {
      draw(id,{...base,aria:{enabled:true,label:{description:t(labels[id])}},tooltip:{...base.tooltip,formatter:items=>escape(items[0]?.axisValue??'')+items.map(item=>'<div>'+escape(item.seriesName)+': <b>'+escape(percent(item.value/100))+'</b></div>').join('')},grid:{left:narrow?48:62,right:15,top:52,bottom:55},xAxis:{type:'category',boundaryGap:false,data:result.testDates,axisLabel:{color:p.muted,hideOverlap:true,formatter:date=>date.slice(0,7)},axisLine:{lineStyle:{color:p.line}}},yAxis:{type:'value',axisLabel:{color:p.muted,formatter:value=>number(value)+'%'},splitLine:{lineStyle:{color:p.line}}},dataZoom:[{type:'inside'},{type:'slider',height:14,bottom:5,borderColor:p.line}],series:ps.map((portfolio,index)=>({type:'line',name:name(portfolio),symbol:'none',data:drawdown?portfolio.testStats.drawdown.map(value=>value*100):portfolio.testStats.wealth.map(value=>(value-1)*100),lineStyle:{width:2,type:portfolio.mode==='equal'?'dashed':'solid'},itemStyle:{color:p.colors[index]}}))});
    }
    const horizontal=$('backtest-weights-chart').clientWidth<520;
    const categories={type:'category',data:result.trainModel.names.map(name=>lastState.data.demo||lastState.data.official?t(name):name),axisLabel:{color:p.muted,interval:0,rotate:horizontal?0:25,fontSize:10,formatter:value=>value.length>17?value.slice(0,16)+'…':value}};
    const values={type:'value',axisLabel:{color:p.muted,formatter:value=>number(value)+'%'},splitLine:{lineStyle:{color:p.line}}};
    draw('backtest-weights-chart',{...base,aria:{enabled:true,label:{description:t(labels['backtest-weights-chart'])}},grid:{left:horizontal?120:48,right:15,top:52,bottom:horizontal?35:82},xAxis:horizontal?values:categories,yAxis:horizontal?categories:values,tooltip:{...base.tooltip,valueFormatter:value=>percent(value/100)},series:ps.map(portfolio=>({type:'bar',name:name(portfolio),data:portfolio.weights.map(value=>value*100),barMaxWidth:18}))});
  }
  function render() {
    sync();
    if(lastStatus)status(lastStatus.key,lastStatus.error,lastStatus.values);
    if(!result)return;
    $('backtest-results').hidden=false;$('backtest-export-button').disabled=false;
    $('backtest-train-period').textContent=result.trainDates[0]+' — '+result.trainDates.at(-1);
    $('backtest-test-period').textContent=result.testDates[0]+' — '+result.testDates.at(-1);
    $('backtest-capital').textContent=money(result.capital);$('backtest-rf').textContent=percent(result.rf);
    $('backtest-table').querySelector('tbody').innerHTML=portfolios().map(portfolio=>{
      const s=portfolio.testStats;
      return '<tr><td>'+escape(name(portfolio))+'</td><td>'+percent(portfolio.weights[0])+'</td><td>'+percent(portfolio.trainingStats.expectedReturn)+'</td><td>'+percent(s.realizedReturn)+'</td><td>'+percent(s.totalReturn)+'</td><td>'+percent(s.cagr)+'</td><td>'+percent(s.risk)+'</td><td>'+(s.sharpe===null?t('Не определён'):new Intl.NumberFormat(locale(),{maximumFractionDigits:2}).format(s.sharpe))+'</td><td>'+percent(s.maxDrawdown)+'</td><td>'+(s.recoveryIncomplete?'≥ ':'')+number(s.maxRecovery)+' '+t('дн.')+'</td><td>'+money(s.finalCapital)+'</td></tr>';
    }).join('');
    if(result.errors.length&&lastStatus?.key==='Проверка готова. Веса рассчитаны только на обучающем периоде.') {
      const explanation=result.errors.map(error=>t(modes[error.mode])+': '+translateError(error.message)).join(' ');
      $('backtest-status').textContent=t('Проверка выполнена. Недоступные критерии: {reason}',{reason:explanation});$('backtest-status').classList.add('error');$('backtest-status').hidden=false;
    }
    renderCharts();
  }
  async function run(event) {
    event.preventDefault();$('backtest-run-button').disabled=true;
    try {
      await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
      const next=runBacktest(lastState.data,{...lastState,splitDate:$('backtest-split').value,settings:{lambda:numeric('backtest-lambda'),targetReturn:numeric('backtest-target-return')/100,targetRisk:numeric('backtest-target-risk')/100}});
      result=next;status('Проверка готова. Веса рассчитаны только на обучающем периоде.');render();
    }catch(error){status(error.message,true);}
    finally {$('backtest-run-button').disabled=lastState.data.rows.length<25;requestAnimationFrame(()=>$('backtest-status').scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'}));}
  }
  function exportWorkbook() {
    if(!result)return;
    const ps=portfolios(),book=XLSX.utils.book_new(),add=(rows,title)=>XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),t(title));
    add([[t('Портфель'),t('Доходность на обучении / год'),t('Фактическая средняя доходность / год'),t('Итоговая доходность'),'CAGR',t('Волатильность'),t('Шарп'),t('Макс. просадка'),t('Капитал на конец периода')],...ps.map(portfolio=>{const s=portfolio.testStats;return [name(portfolio),portfolio.trainingStats.expectedReturn,s.realizedReturn,s.totalReturn,s.cagr,s.risk,s.sharpe,s.maxDrawdown,s.finalCapital];})], 'Показатели');
    add([[t('Индикатор'),...ps.map(name)],...result.trainModel.names.map((value,index)=>[lastState.data.demo?t(value):value,...ps.map(portfolio=>portfolio.weights[index])])],'Веса');
    add([[t('Дата'),...ps.map(name)],...result.testDates.map((date,index)=>[date,...ps.map(portfolio=>portfolio.testStats.wealth[index]*result.capital)])],'Проверочный капитал');
    add([[t('Дата'),...ps.map(name)],...result.testDates.map((date,index)=>[date,...ps.map(portfolio=>portfolio.testStats.drawdown[index])])],'Просадки');
    const boundary=lastState.data.rows.findIndex(row=>row.date===result.splitDate),rows=lastState.data.rows;
    const dataRows=subset=>[[t('Дата'),t('ИПЦ'),...lastState.data.names.map(name=>lastState.data.demo?t(name):name)],...subset.map(row=>[row.date,row.cpi,...row.values])];
    add(dataRows(rows.slice(0,boundary+1)),'Обучающие данные');add(dataRows(rows.slice(boundary)),'Проверочные данные');
    add([[t('Параметр'),t('Значение')],[t('Источник'),lastState.data.source],[t('Последняя дата обучения'),result.splitDate],[t('Начальный капитал, ₽'),result.capital],[t('Номинальная ставка'),result.nominalRf],[t('Реальная безрисковая ставка'),result.rf],[t('Периодов в год'),lastState.frequency],[t('Ребалансировка'),t('Каждый период, без комиссий и налогов')],[t('Методика'),t('Веса и ставка определены только на обучении; показатели результата измерены на проверке.')],...Object.entries(result.settings),...result.errors.map(error=>[t(modes[error.mode]),translateError(error.message)])],'Методика');
    XLSX.writeFile(book,t('Проверка_портфелей.xlsx'),{compression:true});
  }
  $('backtest-form').addEventListener('submit',run);
  $('backtest-export-button').addEventListener('click',exportWorkbook);
  document.querySelectorAll('[data-backtest-download]').forEach(button=>button.addEventListener('click',()=>{
    const id=button.dataset.backtestDownload,chart=charts.get(id);if(!chart)return;
    const link=document.createElement('a');link.href=chart.getDataURL({type:'svg'});link.download=t(labels[id])+'.svg';document.body.append(link);link.click();link.remove();
  }));
  return {sync,render,resize:()=>{charts.forEach(chart=>chart.resize());renderCharts();}};
}
