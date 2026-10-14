import test from 'node:test';
import assert from 'node:assert/strict';
import {officialData} from './fixtures.mjs';
import {estimate,createOptimizer,metrics} from '../dist/engine.js';
import {macroSeries} from '../dist/macro.js';

test('monthly, annual and cumulative inflation preserve actual CPI ratios without filling missing history',()=>{
  const data=officialData(),macro=macroSeries(data);
  assert.equal(macro.monthlyInflation[0],null);
  assert.deepEqual(macro.annualInflation.slice(0,12),Array(12).fill(null));
  assert.equal(macro.annualInflation[12],data.rows[12].cpi/data.rows[0].cpi-1);
  assert.equal(macro.accumulatedInflation[0],0);
  assert.equal(macro.accumulatedInflation.at(-1),data.rows.at(-1).cpi/data.rows[0].cpi-1);
  assert.deepEqual(macro.moneySupply,data.rows.map(row=>row.values[0]));
});

test('M2 changes macro charts but cannot change any optimized investment weights, returns or risk',()=>{
  const data=officialData(),changed=structuredClone(data);
  changed.rows.forEach((row,i)=>row.values[0]*=1+i*5);
  const before=estimate(data),after=estimate(changed);
  assert.deepEqual(after,before);
  assert.notDeepEqual(macroSeries(changed).moneySupply,macroSeries(data).moneySupply);
  const a=createOptimizer(before),b=createOptimizer(after);
  for(const mode of ['markowitz','sharpe','risk','return']){
    const parameters={rf:.01,lambda:3,targetReturn:.1,targetRisk:.2};
    const p=a.solve(mode,parameters),q=b.solve(mode,parameters);
    assert.deepEqual(q,p);assert.deepEqual(metrics(after,q.weights,.01),metrics(before,p.weights,.01));
  }
});

test('portfolio purchasing power is nominal compounded growth divided by cumulative CPI exactly once',()=>{
  const data=officialData(),model=estimate(data),weights=Array(officialData().names.length-1).fill(1/(officialData().names.length-1)),stat=metrics(model,weights);
  let nominalCapital=1;
  for(let i=0;i<model.nominalReturns.length;i++){
    nominalCapital*=1+model.nominalReturns[i].reduce((s,r)=>s+r/weights.length,0);
    const expected=nominalCapital/(data.rows[i+1].cpi/data.rows[0].cpi);
    assert.ok(Math.abs(stat.wealth[i+1]-expected)<1e-10);
  }
});
