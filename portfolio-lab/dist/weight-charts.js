import {t,locale} from './i18n.js';
const signed=value=>new Intl.NumberFormat(locale(),{signDisplay:'exceptZero',minimumFractionDigits:1,maximumFractionDigits:1}).format(Math.abs(value)<1e-8?0:value)+'%';
export function signedWeightsOption(names,weights,colors,muted){
  const values=weights.map(w=>w*100),minimum=Math.min(0,...values),maximum=Math.max(0,...values),padding=Math.max(5,(maximum-minimum)*.3);
  return {grid:{left:125,right:40,top:25,bottom:35},tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:signed},xAxis:{type:'value',min:minimum-padding,max:maximum+padding,axisLabel:{color:muted,formatter:v=>new Intl.NumberFormat(locale(),{maximumFractionDigits:1}).format(v)+'%'}},yAxis:{type:'category',data:names,axisLabel:{color:muted,fontSize:10,formatter:name=>name.length>19?name.slice(0,18)+'…':name}},series:[{name:t('Веса активов'),type:'bar',barMaxWidth:20,markLine:{silent:true,symbol:['none','none'],label:{show:false},lineStyle:{color:muted,width:1.5,type:'solid'},data:[{xAxis:0}]},data:values.map((value,i)=>({value,itemStyle:{color:colors[i]},label:{show:true,position:value<0?'left':'right',color:muted,fontSize:10,formatter:p=>signed(p.value)}}))}]};
}
