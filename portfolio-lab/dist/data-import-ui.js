import {t,translateError,locale} from './i18n.js';
import {loadOfficialMarketData,readOfficialSnapshot,selectSnapshotPeriod} from './market-data-client.js';
const $=id=>document.getElementById(id);
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function createDataImportView({applyDataset,onUnavailable}) {
  let downloaded=null,lastStatus=null,snapshotInfo=null;
  const formatDate=value=>value?new Date(value).toLocaleString(locale(),{dateStyle:'medium',timeStyle:'short'}):'—';
  function status(key,error=false,values={}) {
    lastStatus={key,error,values};$('online-status').textContent=error?translateError(key):t(key,values);
    $('online-status').classList.toggle('error',error);$('online-status').hidden=false;
  }
  function availability() {
    if(!snapshotInfo)return;
    $('online-availability').hidden=false;
    $('online-availability').textContent=t('Доступны месяцы: {from} — {to}. Обновлено: {date}. Новые публикации проверяются ежедневно.',{...snapshotInfo.availablePeriod,date:formatDate(snapshotInfo.downloadedAt)});
    for(const id of ['online-from','online-to']){$(id).min=snapshotInfo.availablePeriod.from;$(id).max=snapshotInfo.availablePeriod.to;}
  }
  function provenance() {
    if(!downloaded)return;
    $('online-provenance').hidden=false;
    $('online-provenance').innerHTML='<p>'+escape(t('Скачано: {date}. Наблюдений: {count}.',{date:formatDate(downloaded.downloadedAt),count:downloaded.rows.length}))+'</p>'+(downloaded.delivery==='github-actions'?'<p>'+escape(t('Подготовленная официальная статистика. Данные доступны после публикации всеми источниками.'))+'</p>':'')+(downloaded.provenance||[]).map(source=>{
      let link='';try{const url=new URL(source.url);if(url.protocol==='https:'&&['cbr.ru','rosstat.gov.ru','moex.com'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host)))link=url.href;}catch{}
      return '<p>'+(link?'<a href="'+escape(link)+'" target="_blank" rel="noopener">'+escape(t(source.name||'Источник'))+'</a>':escape(t(source.name||'Источник')))+'<span> · '+escape(t(source.method||''))+'</span></p>';
    }).join('');
    $('online-excel-button').hidden=false;
  }
  async function apply(next) {
    await applyDataset({...next,official:true,demo:false});downloaded=next;
    if(next.delivery==='github-actions'){snapshotInfo=next;availability();}
    provenance();status('Загружено {count} наблюдений. Доходности рассчитаны сверх инфляции; М2 показан отдельно.',false,{count:next.rows.length});
  }
  async function load(event) {
    event?.preventDefault();$('online-load-button').disabled=true;$('online-form').setAttribute('aria-busy','true');
    status('Загрузка из ЦБ, Росстата и Мосбиржи…');
    try{await apply(await loadOfficialMarketData($('online-from').value,$('online-to').value,{useCache:false}));}
    catch(error){onUnavailable?.();status(error.name==='TimeoutError'?'Источники отвечают слишком долго. Повторите загрузку.':error.message,true);}
    finally{$('online-load-button').disabled=false;$('online-form').removeAttribute('aria-busy');}
  }
  async function initialize() {
    $('online-load-button').disabled=true;status('Загрузка из ЦБ, Росстата и Мосбиржи…');
    try {
      snapshotInfo=await readOfficialSnapshot();availability();
      const to=snapshotInfo.availablePeriod.to;
      const selected=snapshotInfo.rows.slice(-60),from=selected[0].date.slice(0,7);
      $('online-from').value=from;$('online-to').value=to;
      await apply(selectSnapshotPeriod(snapshotInfo,from,to));
    }catch(error){onUnavailable?.();status(error.message,true);}
    finally{$('online-load-button').disabled=false;}
  }
  function download() {
    if(!downloaded)return;
    const book=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([[t('Дата'),t('ИПЦ'),...downloaded.names.map(name=>t(name))],...downloaded.rows.map(row=>[row.date,row.cpi,...row.values])]),t('Данные'));
    XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([[t('Источник'),t('Ссылка'),t('Методика')],...(downloaded.provenance||[]).map(source=>[t(source.name),source.url,t(source.method)]),[t('Скачано'),downloaded.downloadedAt],[t('М2'),t('Макропоказатель; исключён из инвестиционных весов')]]),t('Источники'));
    XLSX.writeFile(book,t('Данные_ЦБ_Росстат_MOEX.xlsx'),{compression:true});
  }
  $('online-form').addEventListener('submit',load);$('online-excel-button').addEventListener('click',download);
  return {initialize,render:()=>{if(lastStatus)status(lastStatus.key,lastStatus.error,lastStatus.values);availability();provenance();}};
}
