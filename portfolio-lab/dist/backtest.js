import {weightBounds,feasibleWeights} from './constrained-optimizer.js';
import {parseDate,parseTable,estimate,createOptimizer,metrics} from './engine.js';

export const BACKTEST_MODES=Object.freeze(['markowitz','sharpe','risk','return']);
const MIN_PERIODS=12;

/**
 * Chronological holdout: choose portfolio weights using training observations only.
 * The boundary level belongs to both slices so the first held-out return is kept.
 * Constant target weights imply rebalancing every observation period, without fees.
 */
export function runBacktest(data,{
  frequency=12,capital=1000000,nominalRf=.08,splitDate,
  settings={},modes=BACKTEST_MODES,constraints,covariance='sample'
}={}) {
  if(!Array.isArray(data?.names)||!Array.isArray(data?.rows)||data.rows.some(row=>!Array.isArray(row?.values))) {
    throw Error('Для проверки нужны даты, ИПЦ и уровни десяти индикаторов.');
  }
  if(!Number.isFinite(capital)||capital<=0)throw Error('Капитал должен быть положительным конечным числом.');
  if(!Number.isFinite(nominalRf)||nominalRf<=-1)throw Error('Безрисковая ставка должна быть конечным числом больше −100%.');
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
  const trainModel=estimate(trainData,frequency,{covariance,excluded:constraints?.excluded}),testModel=estimate(testData,frequency);
  // This annual rate is known at the boundary and never uses held-out CPI.
  const rf=(1+nominalRf)/(1+trainModel.inflation)-1;
  if(!Number.isFinite(rf)||rf<=-1)throw Error('Не удалось скорректировать ставку на инфляцию обучающего периода.');
  const parameters={lambda:3,targetReturn:.10,targetRisk:.20,...settings};
  const optimizer=createOptimizer(trainModel,constraints),portfolios=[],errors=[];
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
  const {lower,upper}=weightBounds(trainModel.names.length,constraints),weights=feasibleWeights(lower,upper);
  const benchmark={mode:'equal',weights,trainingStats:stats(trainModel,weights),testStats:stats(testModel,weights)};
  return {
    splitDate:validated.rows[boundary].date,requestedSplitDate,
    trainDates:[...trainModel.dates],testDates:[...testModel.dates],
    trainModel,testModel,rf,nominalRf,capital,settings:parameters,
    constraints,covariance,kind:'holdout',rfBasis:'training-inflation',rebalancing:'each-period',
    portfolios,benchmark,errors
  };
}

/** Moving training window, followed by disjoint out-of-sample holding blocks. */
export function runRollingBacktest(data,{frequency=12,capital=1000000,nominalRf=.08,window=36,step=3,settings={},modes=BACKTEST_MODES,constraints,covariance='sample'}={}) {
  if(!Number.isInteger(window)||window<12||!Number.isInteger(step)||step<1||step>12)throw Error('Окно обучения — целое число от 12 месяцев; шаг пересчёта — от 1 до 12 месяцев.');
  if(frequency!==12)throw Error('Rolling backtest использует месячные данные.');
  if(!Number.isFinite(capital)||capital<=0||!Number.isFinite(nominalRf)||nominalRf<=-1||!settings||typeof settings!=='object'||Array.isArray(settings))throw Error('Проверьте капитал, ставку и параметры проверки.');
  if(!Array.isArray(modes)||!modes.length||new Set(modes).size!==modes.length||modes.some(m=>!BACKTEST_MODES.includes(m)))throw Error('Выберите различные критерии оптимизации.');
  const validated=parseTable([['Дата','ИПЦ',...data.names],...data.rows.map(r=>[r.date,r.cpi,...r.values])]),rows=validated.rows;
  if(rows.length-1-window<12)throw Error('После окна обучения нужны минимум 12 месяцев проверки. Уменьшите окно или расширьте период данных.');
  // Validate every timestamp before slicing; estimator options affect training only.
  estimate(validated,frequency);
  const parameters={lambda:3,targetReturn:.1,targetRisk:.2,...settings},bounds=weightBounds(data.names.length-1,constraints),benchmarkWeights=feasibleWeights(bounds.lower,bounds.upper);
  const records=new Map([...modes,'equal'].map(mode=>[mode,{mode,returns:[],folds:[],trainingReturns:[],rates:[]}])),errors=[],windows=[];
  let firstTrain,lastTrain;
  for(let boundary=window;boundary<rows.length-1;boundary+=step) {
    const end=Math.min(rows.length-1,boundary+step),training={...validated,rows:rows.slice(boundary-window,boundary+1)};
    const trainModel=estimate(training,frequency,{covariance,excluded:constraints?.excluded}),optimizer=createOptimizer(trainModel,constraints||{}),rf=(1+nominalRf)/(1+trainModel.inflation)-1;
    firstTrain??=trainModel;lastTrain=trainModel;
    const testDates=rows.slice(boundary,end+1).map(r=>r.date),realReturns=rows.slice(boundary+1,end+1).map((row,j)=>trainModel.sourceIndices.map(i=>(row.values[i]/rows[boundary+j].values[i])/(row.cpi/rows[boundary+j].cpi)-1));
    const fold={trainFrom:trainModel.dates[0],trainTo:trainModel.dates.at(-1),testFrom:testDates[1],testTo:testDates.at(-1),boundary:rows[boundary].date,rf,shrinkage:trainModel.shrinkage};windows.push(fold);
    for(const [mode,record] of records) {
      if(record.failed)continue;
      try {
        const relevant={rf,...({markowitz:{lambda:parameters.lambda},risk:{targetReturn:parameters.targetReturn},return:{targetRisk:parameters.targetRisk}}[mode]||{})};
        const weights=mode==='equal'?[...benchmarkWeights]:optimizer.solve(mode,relevant).weights;
        const trainingReturn=trainModel.mu.reduce((sum,v,i)=>sum+v*weights[i],0),values=realReturns.map(row=>row.reduce((sum,v,i)=>sum+v*weights[i],0));
        if(values.some(v=>!Number.isFinite(v)||v<=-1))throw Error('На проверке потерян весь капитал. Уменьшите размер коротких позиций.');
        record.returns.push(...values);record.rates.push(...values.map(()=>rf));record.trainingReturns.push(...values.map(()=>trainingReturn));record.folds.push({...fold,weights:[...weights]});
      }catch(error){record.failed=true;errors.push({mode,message:`${fold.trainTo}: ${error.message}`});}
    }
  }
  const testDates=rows.slice(window).map(r=>r.date);
  function pack(record){
    const values=record.returns,T=values.length,average=values.reduce((a,b)=>a+b,0)/T,risk=values.reduce((sum,v)=>sum+(v-average)**2,0)/(T-1)*frequency;
    const rf=record.rates.reduce((a,b)=>a+b,0)/T;
    const observed={mu:[average*frequency],cov:[[risk]],returns:values.map(v=>[v]),frequency,dates:testDates};
    const measured=metrics(observed,[1],rf,capital);
    return {mode:record.mode,weights:[...record.folds.at(-1).weights],folds:record.folds,returns:values,rf,trainingStats:{expectedReturn:record.trainingReturns.reduce((a,b)=>a+b,0)/T},testStats:{...measured,realizedReturn:measured.expectedReturn,realizedIncome:measured.expectedIncome}};
  }
  const portfolios=[];for(const mode of modes){const record=records.get(mode);if(!record.failed)try{portfolios.push(pack(record));}catch(error){errors.push({mode,message:error.message});}}
  const benchmark=pack(records.get('equal'));
  return {kind:'rolling',window,step,windows,constraints,covariance,trainModel:lastTrain,testModel:null,trainDates:[firstTrain.dates[0],lastTrain.dates.at(-1)],testDates,splitDate:rows[window].date,capital,nominalRf,rf:benchmark.rf,settings:parameters,rfBasis:'per-window-training-inflation',rebalancing:'each-period',portfolios,benchmark,errors};
}
