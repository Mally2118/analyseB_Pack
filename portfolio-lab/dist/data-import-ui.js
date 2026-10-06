import {parseTable} from './engine.js';
import {t,translateError} from './i18n.js';

const $=id=>document.getElementById(id);
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function createDataImportView({applyDataset,uploadExample}) {
  let downloaded=null,lastStatus=null;
  function status(key,error=false,values={}) {
    lastStatus={key,error,values};$('online-status').textContent=error?translateError(key):t(key,values);
    $('online-status').classList.toggle('error',error);$('online-status').hidden=false;
  }
  function provenance() {
    if(!downloaded)return;
    $('online-provenance').hidden=false;
    $('online-provenance').innerHTML='<p>'+escape(t('Скачано: {date}. Наблюдений: {count}.',{date:downloaded.downloadedAt?.slice(0,10)||'—',count:downloaded.rows.length}))+'</p>'+(downloaded.provenance||[]).map(source=>{
      let link='';
      try {const url=new URL(source.url);if(url.protocol==='https:'&&['cbr.ru','rosstat.gov.ru','moex.com'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host)))link=url.href;}catch{}
      const title=escape(t(source.name||'Источник'));
      return '<p>'+(link?'<a href="'+escape(link)+'" target="_blank" rel="noopener">'+title+'</a>':title)+'<span> · '+escape(t(source.method||''))+'</span></p>';
    }).join('');
    $('online-excel-button').hidden=false;
  }
  async function load(event) {
    event.preventDefault();const button=$('online-load-button');button.disabled=true;$('online-form').setAttribute('aria-busy','true');
    status('Загрузка из ЦБ, Росстата и Мосбиржи…');
    try {
      const query=new URLSearchParams({from:$('online-from').value,to:$('online-to').value});
      const response=await fetch('api/market-data?'+query,{signal:AbortSignal.timeout(65000),headers:{Accept:'application/json'}});
      const contentType=response.headers.get('content-type')||'';
      if(!contentType.includes('application/json'))throw Error('Для автозагрузки запустите сайт через «Запустить.bat» или npm start. Статический хостинг не предоставляет API статистики.');
      const next=await response.json();
      if(!response.ok)throw Error(next.error||'Не удалось получить официальные данные. Попробуйте другой период.');
      if(!Array.isArray(next.names)||!Array.isArray(next.rows)||next.rows.some(row=>!Array.isArray(row?.values))||next.demo)throw Error('Источник вернул некорректные данные. Предыдущая выборка сохранена.');
      const parsed=parseTable([['Дата','ИПЦ',...next.names],...next.rows.map(row=>[row.date,row.cpi,...row.values])]);
      await applyDataset({...next,...parsed,source:next.source,demo:false,official:true},{official:true});
      downloaded={...next,...parsed,source:next.source,demo:false};provenance();
      status('Загружено {count} наблюдений. Откройте «Портфель», «Сравнение» или «Проверка».',false,{count:next.rows.length});
    }catch(error) {
      status(error.name==='TimeoutError'?'Источники отвечают слишком долго. Повторите загрузку.':error.message||'Не удалось получить официальные данные. Попробуйте другой период.',true);
    }finally {button.disabled=false;$('online-form').removeAttribute('aria-busy');requestAnimationFrame(()=>$('online-status').scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'}));}
  }
  function download() {
    if(!downloaded)return;
    const book=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([[t('Дата'),t('ИПЦ'),...downloaded.names.map(name=>t(name))],...downloaded.rows.map(row=>[row.date,row.cpi,...row.values])]),t('Данные'));
    XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([[t('Источник'),t('Ссылка'),t('Методика')],...(downloaded.provenance||[]).map(source=>[source.name,source.url,source.method]),[t('Скачано'),downloaded.downloadedAt],[t('Первый месяц'),downloaded.period?.from],[t('Последний месяц'),downloaded.period?.to],[t('ИПЦ'),t('Накопленный индекс, база 100 на первом наблюдении.')],...(downloaded.notes||[]).map(note=>[t('Примечание'),note])]),t('Источники'));
    XLSX.writeFile(book,t('Данные_ЦБ_Росстат_MOEX.xlsx'),{compression:true});
  }
  $('online-form').addEventListener('submit',load);$('online-excel-button').addEventListener('click',download);
  document.querySelectorAll('[data-load-example]').forEach(button=>button.addEventListener('click',async()=>{
    const buttons=[...document.querySelectorAll('[data-load-example]')];buttons.forEach(button=>button.disabled=true);
    try {
      const profile=button.dataset.loadExample,response=await fetch('examples/portfolio-'+profile+'.xlsx');
      if(!response.ok)throw Error('Учебный файл не найден. Перезапустите приложение.');
      await uploadExample(new File([await response.arrayBuffer()],'portfolio-'+profile+'.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
    }catch(error){status(error.message,true);$('online-status').scrollIntoView({block:'nearest'});}
    finally {buttons.forEach(button=>button.disabled=false);}
  }));
  return {render:()=>{if(lastStatus)status(lastStatus.key,lastStatus.error,lastStatus.values);provenance();}};
}
