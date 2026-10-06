import {parseTable,estimate,createOptimizer,metrics} from './engine.js';

export const exampleDefinitions=[
  {profile:'m2-90-67',name:'М2 — 90,67%',m2Share:.9067},
  {profile:'m2-60-67',name:'М2 — 60,67%',m2Share:.6067},
  {profile:'m2-10-00',name:'М2 — 10% · недвижимость',m2Share:.10}
];
export const exampleProfiles=exampleDefinitions.map(example=>example.profile);

// Keep each example's model: applying its weights to another workbook would
// produce a different portfolio history and misleading comparison metrics.
export function examplePortfolio(table,profile) {
  const definition=exampleDefinitions.find(example=>example.profile===profile);
  if(!definition)throw Error('Неизвестный учебный пример.');
  const data={...parseTable(table),demo:true,source:'Учебный пример · синтетические данные'};
  const model=estimate(data,12,false),optimizer=createOptimizer(model);
  const nominalRf=.08,rf=(1+nominalRf)/(1+model.inflation)-1;
  const settings={rf,nominalRf},solution=optimizer.solve('sharpe',settings);
  metrics(model,solution.weights,rf,1000000);
  return {...solution,profile,mode:'sharpe',name:definition.name,settings,snapshot:{data,model,frontier:optimizer.frontier},visible:true};
}

export async function loadExamplePortfolios() {
  return Promise.all(exampleProfiles.map(async profile=>{
    const response=await fetch('examples/portfolio-'+profile+'.xlsx');
    if(!response.ok)throw Error('Учебный файл не найден. Перезапустите приложение.');
    const book=globalThis.XLSX.read(await response.arrayBuffer(),{type:'array',cellDates:true});
    return examplePortfolio(globalThis.XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,defval:null,raw:true}),profile);
  }));
}
