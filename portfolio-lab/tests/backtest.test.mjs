import test from 'node:test';
import assert from 'node:assert/strict';
import {demoData,estimate,createOptimizer,dot} from '../dist/engine.js';
import {runBacktest} from '../dist/backtest.js';

const close=(actual,expected,tolerance=1e-9)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`);
const demo=demoData(),splitDate=demo.rows[59].date;
const options={splitDate,nominalRf:.08,capital:1000000,settings:{lambda:3,targetReturn:.08,targetRisk:.20}};

test('holdout keeps the boundary observation and every return exactly once',()=>{
  const result=runBacktest(demo,options);
  assert.equal(result.trainDates.length,60);
  assert.equal(result.testDates.length,26);
  assert.equal(result.trainDates.at(-1),splitDate);
  assert.equal(result.testDates[0],splitDate);
  assert.equal(result.testDates[1],demo.rows[60].date);
  assert.equal(result.trainModel.returns.length+result.testModel.returns.length,demo.rows.length-1);
  assert.deepEqual([...result.trainDates,...result.testDates.slice(1)],demo.rows.map(row=>row.date));
  assert.equal(result.rfBasis,'training-inflation');
  assert.equal(result.rebalancing,'each-period');
  close(result.rf,(1+.08)/(1+result.trainModel.inflation)-1);
});

test('changing future prices and inflation never changes training weights or rate',()=>{
  const first=runBacktest(demo,options),changed=structuredClone(demo);
  changed.rows.forEach((row,i)=>{
    if(i<=59)return;
    row.cpi*=Math.pow(1.025,i-59);
    row.values=row.values.map((value,j)=>value*Math.pow(j%2?1.04:.985,i-59));
  });
  const second=runBacktest(changed,options);
  assert.deepEqual(second.trainModel,first.trainModel);
  assert.equal(second.rf,first.rf);
  assert.deepEqual(second.portfolios.map(({mode,weights,trainingStats})=>({mode,weights,trainingStats})),first.portfolios.map(({mode,weights,trainingStats})=>({mode,weights,trainingStats})));
  assert.deepEqual(second.errors,first.errors);
  assert.notEqual(second.testModel.inflation,first.testModel.inflation);
  assert.notEqual(second.portfolios[0].testStats.totalReturn,first.portfolios[0].testStats.totalReturn);
});

test('held-out paths use training weights, period CPI and the same training rate',()=>{
  const result=runBacktest(demo,options),trainingOptimizer=createOptimizer(result.trainModel);
  assert.equal(result.portfolios.length,4);
  assert.deepEqual(result.errors,[]);
  for(const portfolio of result.portfolios) {
    assert.deepEqual(portfolio.weights,trainingOptimizer.solve(portfolio.mode,{...options.settings,rf:result.rf}).weights);
    const returns=result.testModel.returns.map(row=>dot(row,portfolio.weights));
    const terminalWealth=returns.reduce((wealth,value)=>wealth*(1+value),1);
    close(portfolio.testStats.wealth[0],1);
    close(portfolio.testStats.wealth.at(-1),terminalWealth);
    close(portfolio.testStats.realizedReturn,returns.reduce((sum,value)=>sum+value,0)/returns.length*12);
    close(portfolio.testStats.realizedIncome,portfolio.testStats.realizedReturn*options.capital,1e-6);
    close(portfolio.testStats.sharpe,(portfolio.testStats.realizedReturn-result.rf)/portfolio.testStats.risk);
  }
  close(result.testModel.returns[0][0],demo.rows[60].values[0]/demo.rows[59].values[0]/(demo.rows[60].cpi/demo.rows[59].cpi)-1);
  assert.deepEqual(result.benchmark.weights,Array(10).fill(.1));
  close(result.benchmark.testStats.wealth.at(-1),result.testModel.returns.reduce((wealth,row)=>wealth*(1+row.reduce((sum,value)=>sum+value,0)/10),1));
});

test('infeasible criteria return explicit errors while valid portfolios and benchmark remain',()=>{
  const result=runBacktest(demo,{...options,settings:{targetReturn:100,targetRisk:0,lambda:3}});
  assert.deepEqual(result.portfolios.map(portfolio=>portfolio.mode),['markowitz','sharpe']);
  assert.deepEqual(result.errors.map(error=>error.mode),['risk','return']);
  assert.ok(result.errors.every(error=>typeof error.message==='string'&&error.message.length>0));
  assert.ok(result.benchmark.testStats.wealth.at(-1)>0);
  const invalidLambda=runBacktest(demo,{...options,settings:{...options.settings,lambda:-1}});
  assert.deepEqual(invalidLambda.errors.map(error=>error.mode),['markowitz']);
  assert.deepEqual(invalidLambda.portfolios.map(portfolio=>portfolio.mode),['sharpe','risk','return']);
  const excessiveRate=runBacktest(demo,{...options,nominalRf:10});
  assert.deepEqual(excessiveRate.errors.map(error=>error.mode),['sharpe']);
});

test('split validation requires twelve returns in both periods and rejects malformed input',()=>{
  assert.throws(()=>runBacktest(demo,{...options,splitDate:demo.rows[11].date}),/12 периодов.*обучения/);
  assert.throws(()=>runBacktest(demo,{...options,splitDate:demo.rows[73].date}),/12 периодов.*проверки/);
  const minimum={...demo,rows:demo.rows.slice(0,25)};
  const result=runBacktest(minimum,{splitDate:minimum.rows[12].date});
  assert.equal(result.trainModel.returns.length,12);
  assert.equal(result.testModel.returns.length,12);
  assert.throws(()=>runBacktest({...demo,rows:demo.rows.slice(0,24)}),/минимум 25/);
  assert.throws(()=>runBacktest(demo,{splitDate:'2022-02-30'}),/Некорректная дата/);
  assert.throws(()=>runBacktest(demo,{splitDate:'30.06.2023'}),/ГГГГ-ММ-ДД/);
  assert.throws(()=>runBacktest(demo,{capital:-1}),/Капитал/);
  assert.throws(()=>runBacktest(demo,{nominalRf:-1}),/ставка/);
  assert.throws(()=>runBacktest(demo,{nominalRf:Infinity}),/ставка/);
  assert.throws(()=>runBacktest(demo,{frequency:4}),/периодичность/);
  assert.throws(()=>runBacktest(demo,{cash:'yes'}),/логическим/);
  assert.throws(()=>runBacktest(demo,{modes:['unknown']}),/критериев/);
  assert.throws(()=>runBacktest(demo,{modes:['sharpe','sharpe']}),/различных/);
  const invalid=structuredClone(demo);invalid.rows[65].cpi=0;
  assert.throws(()=>runBacktest(invalid,options),/положительное/);
});

test('default boundary and dates between observations resolve to available training dates',()=>{
  const result=runBacktest(demo);
  assert.equal(result.splitDate,demo.rows[58].date);
  const between=runBacktest(demo,{...options,splitDate:'2023-12-15'});
  assert.equal(between.splitDate,'2023-11-30');
  assert.equal(between.requestedSplitDate,'2023-12-15');
});

test('cash mode is consistent in training and test without mutating input data',()=>{
  const original=structuredClone(demo),result=runBacktest(demo,{...options,cash:true,modes:['markowitz']});
  assert.deepEqual(demo,original);
  close(result.testModel.returns[0][0],demo.rows[59].cpi/demo.rows[60].cpi-1);
  assert.equal(result.testModel.names[0],'Рублёвый остаток');
  assert.deepEqual(result.trainModel,estimate({...demo,rows:demo.rows.slice(0,60)},12,true));
});
