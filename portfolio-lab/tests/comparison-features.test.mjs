import test from 'node:test';
import assert from 'node:assert/strict';
import {demoData,estimate,createOptimizer,metrics} from '../dist/engine.js';
import {commonDates,evaluatePortfolio,comparisonStat,metricComparison,serializeComparison,restoreComparison,readComparisonSets,saveComparisonSet,deleteComparisonSet} from '../dist/comparison.js';

const data=demoData(),model=estimate(data),optimizer=createOptimizer(model),nominalRf=.08,rf=1.08/(1+model.inflation)-1;
const settings={rf,nominalRf,lambda:3,targetReturn:.1,targetRisk:.2};
const current={...optimizer.solve('sharpe',settings),id:'current',mode:'sharpe',name:'Максимум Шарпа',settings,visible:true,compared:true};
const context={data,model,rf,nominalRf,capital:1e6};
const period={from:'2020-01-31',to:'2024-01-31'};
const memoryStorage=()=>{const map=new Map();return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value)};};
const state=()=>({...context,current,saved:[],sequence:0,period,baselineId:'current',selectedReportId:'current',reportView:'drawdown',highlight:false});

test('a common period uses every return between the endpoints, resets initial capital and keeps the original weights and model',()=>{
  const evaluated=evaluatePortfolio(current,context,period);
  const expectedModel=estimate({...data,rows:data.rows.slice(12,61)},12);
  const expected=metrics(expectedModel,current.weights,1.08/(1+expectedModel.inflation)-1,1e6);
  assert.deepEqual(comparisonStat(current,context,period),expected);
  assert.equal(expected.wealth[0],1);assert.equal(expected.wealth.length,49);
  assert.equal(evaluated.portfolio.weights,current.weights);assert.equal(data.rows.length,85);assert.equal(model.dates.length,85);
  assert.equal(evaluatePortfolio(current,context,period).model,evaluated.model);
});

test('different histories expose only shared endpoints and reject incomplete or inverted periods',()=>{
  const shorterData={...data,rows:data.rows.slice(12)},shorterModel=estimate(shorterData);
  const another={...current,id:'p1',snapshot:{data:shorterData,model:shorterModel},settings:{rf:1.08/(1+shorterModel.inflation)-1,nominalRf}};
  assert.deepEqual(commonDates([current,another],context),shorterModel.dates);
  assert.throws(()=>comparisonStat(another,context,{from:'2019-01-31',to:'2024-01-31'}),/даты/);
  assert.throws(()=>comparisonStat(current,context,{from:'2025-07-31',to:'2026-01-31'}),/13 наблюдений/);
  assert.throws(()=>comparisonStat(current,context,{from:period.to,to:period.from}),/даты/);
  assert.deepEqual(commonDates([],context),[]);
});

test('metric ranking respects risk, negative drawdowns, ties, null Sharpe and incomplete recovery bounds',()=>{
  assert.deepEqual(metricComparison([{risk:.1},{risk:.2},{risk:.1}],'risk',-1).best,[0,2]);
  assert.deepEqual(metricComparison([{maxDrawdown:-.3},{maxDrawdown:-.1}],'maxDrawdown',1).best,[1]);
  assert.deepEqual(metricComparison([{sharpe:null},{sharpe:2},{sharpe:1}],'sharpe',1).worst,[2]);
  assert.deepEqual(metricComparison([{risk:.1},{risk:.1+1e-12}],'risk',-1).best,[]);
  assert.equal(metricComparison([{maxRecovery:10},{maxRecovery:5,recoveryIncomplete:true}],'maxRecovery',-1).comparable,false);
  assert.equal(metricComparison([{openRecovery:0},{openRecovery:5}],'openRecovery',-1).comparable,false);
});

test('saved state roundtrip restores independent datasets, visibility, removed current, period and baseline with unchanged metrics',()=>{
  const extraData={...data,rows:data.rows.map(row=>({...row,values:row.values.map((value,index)=>index===1?value*2:value)}))};
  const extraModel=estimate(extraData),extraRf=1.08/(1+extraModel.inflation)-1;
  const p={...current,id:'p3',name:'Сохранённый вариант',ordinal:3,settings:{...settings,rf:extraRf},visible:false,snapshot:{data:extraData,model:extraModel,frontier:createOptimizer(extraModel).frontier}};
  const input={...state(),current:{...current,compared:false},saved:[p],sequence:3,baselineId:'p3',selectedReportId:'p3'};
  const packed=JSON.parse(JSON.stringify(serializeComparison(input))),restored=restoreComparison(packed);
  assert.equal(packed.sources.length,2);assert.equal(restored.current.compared,false);assert.equal(restored.saved[0].visible,false);
  assert.equal(restored.baselineId,'p3');assert.equal(restored.selectedReportId,'p3');assert.equal(restored.reportView,'drawdown');assert.equal(restored.highlight,false);
  assert.deepEqual(restored.period,period);assert.deepEqual(restored.saved[0].weights,p.weights);
  assert.deepEqual(comparisonStat(restored.saved[0],restored,period),comparisonStat(p,context,period));
});

test('restoration rejects corrupt weights, invalid sources, duplicate ids, bad settings, sequence and unsupported versions',()=>{
  for(const mutate of [p=>p.current.weights[0]=-1,p=>p.current.weights.pop(),p=>p.current.source=50,p=>p.saved=[p.current],p=>p.current.settings.nominalRf=-1,p=>p.sequence=-1,p=>p.version=2,p=>p.sources[0].rows[1].date=p.sources[0].rows[0].date]){
    const packed=JSON.parse(JSON.stringify(serializeComparison(state())));mutate(packed);assert.throws(()=>restoreComparison(packed));
  }
});

test('named sets survive rereads, same names replace a set, deletion is persisted and failed writes leave the stored library intact',()=>{
  const storage=memoryStorage(),payload=serializeComparison(state());
  const first=saveComparisonSet(storage,[],'  Исследование  ',payload);
  assert.equal(readComparisonSets(storage)[0].name,'Исследование');
  const updated=saveComparisonSet(storage,readComparisonSets(storage),'Исследование',{...payload,capital:2e6});
  assert.equal(updated.entries.length,1);assert.equal(updated.id,first.id);assert.equal(readComparisonSets(storage)[0].payload.capital,2e6);
  const second=saveComparisonSet(storage,readComparisonSets(storage),'Другой',payload);
  const before=JSON.stringify(readComparisonSets(storage));
  const failing={getItem:storage.getItem,setItem:()=>{throw new DOMException('full','QuotaExceededError');}};
  assert.throws(()=>saveComparisonSet(failing,second.entries,'Третий',payload),{name:'QuotaExceededError'});
  assert.equal(JSON.stringify(readComparisonSets(storage)),before);
  deleteComparisonSet(storage,readComparisonSets(storage),first.id);assert.equal(readComparisonSets(storage).length,1);
  assert.throws(()=>saveComparisonSet(storage,[],'',payload),/название/);
  const ten=Array.from({length:10},(_,i)=>({id:String(i),name:String(i)}));assert.throws(()=>saveComparisonSet(storage,ten,'Новый',payload),/10 наборов/);
});
