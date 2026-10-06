import {parseDate,parseTable,estimate,createOptimizer,metrics} from './engine.js';

export const BACKTEST_MODES=Object.freeze(['markowitz','sharpe','risk','return']);
const MIN_PERIODS=12;

/**
 * Chronological holdout: choose portfolio weights using training observations only.
 * The boundary level belongs to both slices so the first held-out return is kept.
 * Constant target weights imply rebalancing every observation period, without fees.
 */
export function runBacktest(data,{
  frequency=12,cash=false,capital=1000000,nominalRf=.08,splitDate,
  settings={},modes=BACKTEST_MODES
}={}) {
  if(!Array.isArray(data?.names)||!Array.isArray(data?.rows)||data.rows.some(row=>!Array.isArray(row?.values))) {
    throw Error('Для проверки нужны даты, ИПЦ и уровни десяти индикаторов.');
  }
  if(!Number.isFinite(capital)||capital<=0)throw Error('Капитал должен быть положительным конечным числом.');
  if(!Number.isFinite(nominalRf)||nominalRf<=-1)throw Error('Безрисковая ставка должна быть конечным числом больше −100%.');
  if(typeof cash!=='boolean')throw Error('Режим рублёвого остатка должен быть логическим значением.');
  if(!settings||typeof settings!=='object'||Array.isArray(settings))throw Error('Проверьте параметры критериев.');
  if(!Array.isArray(modes)||!modes.length||new Set(modes).size!==modes.length||modes.some(mode=>!BACKTEST_MODES.includes(mode))) {
    throw Error('Выберите один или несколько различных критериев оптимизации.');
  }
  // Reuse the import validation so direct callers receive the same schema checks.
  const validated=parseTable([['Дата','ИПЦ',...data.names],...data.rows.map(row=>[row.date,row.cpi,...row.values])]);
  if(validated.rows.length<MIN_PERIODS*2+1)throw Error('Для проверки нужны минимум 25 уровней: 12 периодов обучения и 12 периодов проверки.');
  if(splitDate===undefined) {
    const index=Math.max(MIN_PERIODS,Math.min(validated.rows.length-1-MIN_PERIODS,Math.floor((validated.rows.length-1)*.7)));
    splitDate=validated.rows[index].date;
  }
  if(typeof splitDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(splitDate))throw Error('Дата разделения должна иметь формат ГГГГ-ММ-ДД.');
  const requestedSplitDate=parseDate(splitDate);
  const boundary=validated.rows.findLastIndex(row=>row.date<=requestedSplitDate);
  if(boundary<MIN_PERIODS)throw Error('До даты разделения нужны минимум 12 периодов доходности для обучения.');
  if(validated.rows.length-1-boundary<MIN_PERIODS)throw Error('После даты разделения нужны минимум 12 периодов доходности для проверки.');
  const trainData={...validated,rows:validated.rows.slice(0,boundary+1)};
  const testData={...validated,rows:validated.rows.slice(boundary)};
  const trainModel=estimate(trainData,frequency,cash),testModel=estimate(testData,frequency,cash);
  // This annual rate is known at the boundary and never uses held-out CPI.
  const rf=(1+nominalRf)/(1+trainModel.inflation)-1;
  if(!Number.isFinite(rf)||rf<=-1)throw Error('Не удалось скорректировать ставку на инфляцию обучающего периода.');
  const parameters={lambda:3,targetReturn:.10,targetRisk:.20,...settings};
  const optimizer=createOptimizer(trainModel),portfolios=[],errors=[];
  const stats=(model,weights)=>{
    const result=metrics(model,weights,rf,capital);
    return {...result,realizedReturn:result.expectedReturn,realizedIncome:result.expectedIncome};
  };
  for(const mode of modes) {
    try {
      // A parameter affects its own criterion only; other criteria remain usable.
      const relevant={rf,...({markowitz:{lambda:parameters.lambda},risk:{targetReturn:parameters.targetReturn},return:{targetRisk:parameters.targetRisk}}[mode]||{})};
      const solution=optimizer.solve(mode,relevant),weights=[...solution.weights];
      portfolios.push({mode,weights,trainingStats:stats(trainModel,weights),testStats:stats(testModel,weights)});
    }catch(error) {
      errors.push({mode,message:error.message});
    }
  }
  const weights=Array(validated.names.length).fill(1/validated.names.length);
  const benchmark={mode:'equal',weights,trainingStats:stats(trainModel,weights),testStats:stats(testModel,weights)};
  return {
    splitDate:validated.rows[boundary].date,requestedSplitDate,
    trainDates:[...trainModel.dates],testDates:[...testModel.dates],
    trainModel,testModel,rf,nominalRf,capital,settings:parameters,
    rfBasis:'training-inflation',rebalancing:'each-period',
    portfolios,benchmark,errors
  };
}
