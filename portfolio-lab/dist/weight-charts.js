import {t,locale} from './i18n.js';
export function signedWeightsOption(names,weights,colors,muted){
  return {grid:{left:125,right:30,top:25,bottom:35},tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:v=>new Intl.NumberFormat(locale(),{maximumFractionDigits:2}).format(v)+'%'},xAxis:{type:'value',axisLabel:{color:muted,formatter:v=>v+'%'}},yAxis:{type:'category',data:names,axisLabel:{color:muted,fontSize:10,formatter:name=>name.length>19?name.slice(0,18)+'…':name}},series:[{name:t('Веса активов'),type:'bar',barMaxWidth:20,data:weights.map((w,i)=>({value:w*100,itemStyle:{color:colors[i]},label:{show:true,position:w<0?'left':'right',color:muted,formatter:p=>p.value.toFixed(1)+'%'}}))}]};
}
