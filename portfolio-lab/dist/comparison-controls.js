import {t,locale} from './i18n.js';
import {commonDates,serializeComparison,restoreComparison,readComparisonSets,saveComparisonSet,deleteComparisonSet} from './comparison.js';

const $=id=>document.getElementById(id);
export function createComparisonControls({getState,onPeriod,onRestore,onBaseline,onHighlight,portfolioName,message}) {
  let entries=[],selectedSet='',appliedKey;
  function library(){
    try{entries=readComparisonSets(localStorage);}catch{entries=[];}
    const select=$('comparison-set-select');select.replaceChildren(new Option(t('Выберите сохранённый набор'),''));
    for(const entry of entries)select.add(new Option(entry.name,entry.id));
    if(!entries.some(entry=>entry.id===selectedSet))selectedSet='';
    select.value=selectedSet;
    $('comparison-set-open').disabled=!selectedSet;$('comparison-set-delete').disabled=!selectedSet;
    const entry=entries.find(entry=>entry.id===selectedSet);
    $('comparison-set-info').textContent=entry?t('Сохранено: {date}',{date:new Date(entry.date).toLocaleString(locale())}):t('Наборы сохраняются в этом браузере вместе с данными и весами. До 10 наборов; повторное имя обновляет существующий.');
  }
  const guard=action=>async event=>{event?.preventDefault();try{await action(event);}catch(error){message(error.name==='QuotaExceededError'?'Недостаточно места в браузере. Удалите ненужный набор; предыдущее сохранение осталось на месте.':error.name==='SecurityError'?'Браузер запретил сохранение. Разрешите хранение данных для сайта.':error.message,true);}};
  $('comparison-period-form').addEventListener('submit',guard(()=>{
    onPeriod({from:$('comparison-from').value,to:$('comparison-to').value});
    message('Общий период применён. Веса сохранены; показатели и графики сравнения пересчитаны.');
  }));
  $('comparison-period-reset').addEventListener('click',guard(()=>{onPeriod(null);message('Сравнение использует всю историю каждого портфеля.');}));
  $('comparison-common-period').addEventListener('click',guard(()=>{
    const state=getState(),dates=commonDates([state.current,...state.saved].filter(p=>p.compared!==false),state);
    if(dates.length<13)throw Error('Нет общего периода с минимум 13 наблюдениями для каждого портфеля.');
    onPeriod({from:dates[0],to:dates.at(-1)});message('Общий период применён. Веса сохранены; показатели и графики сравнения пересчитаны.');
  }));
  $('comparison-baseline').addEventListener('change',()=>onBaseline($('comparison-baseline').value));
  $('comparison-highlight').addEventListener('change',()=>onHighlight($('comparison-highlight').checked));
  $('comparison-set-form').addEventListener('submit',guard(()=>{
    const state=getState();
    if(![state.current,...state.saved].some(p=>p.compared!==false))throw Error('Добавьте хотя бы один портфель перед сохранением набора.');
    const result=saveComparisonSet(localStorage,readComparisonSets(localStorage),$('comparison-set-name').value,serializeComparison(state));
    entries=result.entries;selectedSet=result.id;library();message('Набор сохранён в браузере. Его можно открыть после перезагрузки.');
  }));
  $('comparison-set-select').addEventListener('change',()=>{selectedSet=$('comparison-set-select').value;const entry=entries.find(entry=>entry.id===selectedSet);if(entry)$('comparison-set-name').value=entry.name;library();});
  $('comparison-set-open').addEventListener('click',guard(()=>{
    const entry=readComparisonSets(localStorage).find(entry=>entry.id===selectedSet);
    if(!entry)throw Error('Сохранённый набор не найден.');
    let restored;try{restored=restoreComparison(entry.payload);}catch{throw Error('Сохранённый набор повреждён. Текущее сравнение сохранено.');}
    onRestore(restored);message('Набор открыт. Данные, веса, настройки и период восстановлены.');
  }));
  $('comparison-set-delete').addEventListener('click',guard(()=>{
    entries=deleteComparisonSet(localStorage,readComparisonSets(localStorage),selectedSet);selectedSet='';library();message('Сохранённый набор удалён. Текущее сравнение осталось на месте.');
  }));
  function render(portfolios,context,period,baselineId,highlight){
    library();
    const dates=commonDates(portfolios,context),key=JSON.stringify([period,dates[0],dates.at(-1)]);
    for(const id of ['comparison-from','comparison-to']){$(id).min=dates[0]||'';$(id).max=dates.at(-1)||'';$(id).disabled=!portfolios.length;}
    if(key!==appliedKey){$('comparison-from').value=period?.from||dates[0]||'';$('comparison-to').value=period?.to||dates.at(-1)||'';appliedKey=key;}
    $('comparison-common-period').disabled=dates.length<13;$('comparison-period-apply').disabled=!portfolios.length;
    $('comparison-period-reset').disabled=!period;
    $('comparison-period-status').textContent=period?t('Общий период: {from} — {to}. Веса не меняются.',period):t('Вся история каждого портфеля. Для одинаковых дат выберите общий период.');
    $('comparison-baseline').replaceChildren(...portfolios.map(p=>new Option(portfolioName(p),p.id)));
    $('comparison-baseline').value=baselineId;$('comparison-baseline').disabled=portfolios.length<2;
    $('comparison-highlight').checked=highlight;
  }
  return {render};
}
