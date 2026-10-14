import test from 'node:test';
import assert from 'node:assert/strict';
import {estimate,createOptimizer,dot,variance} from '../dist/engine.js';
import {exposures,exposureLimits,weightBounds} from '../dist/constrained-optimizer.js';
import {runBacktest,runRollingBacktest} from '../dist/backtest.js';
import {serializeComparison,restoreComparison} from '../dist/comparison.js';
import {officialData} from './fixtures.mjs';
const close=(a,b,tolerance=1e-7)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
const example={short:true,minWeight:-.3,maxWeight:1,grossLimit:1.5,shortLimit:.25};
function feasible(weights,options){
 const {lower,upper}=weightBounds(weights.length,options),limits=exposureLimits(options),e=exposures(weights);
 close(e.net,1);close(e.long-e.short,e.net);close(e.long+e.short,e.gross);close(1+2*e.short,e.gross);
 assert.ok(e.gross<=limits.grossLimit+1e-7);assert.ok(e.short<=limits.shortLimit+1e-7);
 weights.forEach((w,i)=>assert.ok(w>=lower[i]-1e-7&&w<=upper[i]+1e-7));
}
const controlled={mu:[.4,-.4,.05],cov:[[.1,0,0],[0,.1,0],[0,0,.01]],stabilized:[[.1,0,0],[0,.1,0],[0,0,.01]]};
test('requested example obeys both leverage limits for every criterion and frontier point',()=>{
 const model=estimate(officialData(),12,{covariance:'oas'}),optimizer=createOptimizer(model,example);
 for(const point of optimizer.frontier)feasible(point.weights,example);
 for(const mode of ['markowitz','sharpe','risk','return'])feasible(optimizer.solve(mode,{rf:0,targetReturn:optimizer.global.return+.02,targetRisk:.5}).weights,example);
 assert.deepEqual(exposureLimits({short:true}),{grossLimit:1.5,shortLimit:.25,shortCap:.25});
});
test('gross and short limits bind independently and agree with an analytical optimum',()=>{
 for(const [grossLimit,shortLimit,expectedShort] of [[1.5,.25,.25],[1.2,.25,.1],[1.5,.05,.05],[1.1,.9,.05],[1,2,0],[5,0,0]]) {
  const options={...example,grossLimit,shortLimit},solution=createOptimizer(controlled,options).solve('markowitz',{lambda:1});feasible(solution.weights,options);
  close(solution.weights[0],1);close(solution.weights[1],-expectedShort);close(solution.weights[2],expectedShort);
 }
});
test('zero short budget and gross=100% prohibit all negative weights in every mode',()=>{
 const model=estimate(officialData()),long=createOptimizer(model);
 for(const options of [{...example,grossLimit:1},{...example,shortLimit:0}]) {
  const optimizer=createOptimizer(model,options);
  for(const mode of ['markowitz','sharpe','risk','return']) {
   const settings={targetReturn:long.global.return+.01,targetRisk:.5},solution=optimizer.solve(mode,settings);feasible(solution.weights,options);assert.ok(solution.weights.every(w=>w>=0));close(solution.objective,long.solve(mode,settings).objective);
  }
 }
});
test('invalid leverage inputs and non-strict weight ranges reject; long-only ignores hidden short fields',()=>{
 for(const options of [{grossLimit:.99},{grossLimit:NaN},{grossLimit:Infinity},{shortLimit:-.01},{shortLimit:NaN},{shortLimit:Infinity},{minWeight:.2,maxWeight:.2},{minWeight:.3,maxWeight:.2}])assert.throws(()=>createOptimizer(controlled,{...example,...options}));
 assert.deepEqual(createOptimizer(controlled,{short:false,grossLimit:.1,shortLimit:-2}).solve('markowitz'),createOptimizer(controlled).solve('markowitz'));
});
test('large nonbinding limits retain box optimum and singular/tied means remain solvable',()=>{
 const model=estimate(officialData()),options={...example,grossLimit:20,shortLimit:10},optimizer=createOptimizer(model,options);optimizer.frontier.forEach(p=>feasible(p.weights,options));
 for(const mu of [[.1,.1,.1],[.2,.2,-.1]]) {
  const tied={...controlled,mu},o=createOptimizer(tied,example);feasible(o.global.weights,example);o.frontier.forEach(p=>feasible(p.weights,example));
 }
});
test('all short holdout and rolling weights obey gross and short budgets, including exclusions',()=>{
 const data=officialData(),constraints={...example,grossLimit:1.3,shortLimit:.1,excluded:[2]},covariance='oas';
 const held=runBacktest(data,{constraints,covariance});for(const p of [...held.portfolios,held.benchmark]){feasible(p.weights,constraints);assert.equal(p.weights[2],0);}
 const rolled=runRollingBacktest(data,{constraints,covariance,window:36,step:6});assert.ok(rolled.portfolios.length>=2);
 for(const p of [...rolled.portfolios,rolled.benchmark])for(const fold of p.folds){feasible(fold.weights,constraints);assert.equal(fold.weights[2],0);}
});
test('saved short sets retain custom budgets and reject tampered gross and short exposure',()=>{
 const data=officialData(),model=estimate(data),constraints={...example,grossLimit:1.2,shortLimit:.07},optimizer=createOptimizer(model,constraints),settings={constraints,covariance:'sample',rf:0,nominalRf:.08,lambda:3},current={...optimizer.solve('markowitz'),id:'current',mode:'markowitz',name:'Марковиц',settings};
 const payload=serializeComparison({data,model,current,saved:[],sequence:0,capital:1e6}),restored=restoreComparison(payload);assert.deepEqual(restored.current.settings.constraints,constraints);assert.deepEqual(restored.current.weights,current.weights);
 for(const change of [p=>p.current.settings.constraints.shortLimit=0,p=>p.current.settings.constraints.grossLimit=1]){const invalid=structuredClone(payload);change(invalid);assert.throws(()=>restoreComparison(invalid));}
});
test('independent feasible grids cannot beat Markowitz with its unchanged objective',()=>{
 const options={...example,grossLimit:1.3,shortLimit:.12},o=createOptimizer(controlled,options),lambda=.7,best=o.solve('markowitz',{lambda}),objective=w=>dot(w,controlled.mu)-lambda*variance(w,controlled.cov);
 let count=0;for(let a=-30;a<=100;a++)for(let b=-30;b<=100;b++){const w=[a/100,b/100,1-a/100-b/100];if(w[2]<-.3||w[2]>1||exposures(w).short>.12+1e-10)continue;count++;assert.ok(objective(w)<=objective(best.weights)+1e-7);}
 assert.ok(count>100);
});

test('old uncapped short sets are retained intact and explicitly reject weights over the new defaults',()=>{
 const data=officialData(),model=estimate(data),current={id:'current',mode:'markowitz',name:'Марковиц',weights:[1,-.3,.3,0,0,0,0,0,0],settings:{rf:0,nominalRf:.08,lambda:3,constraints:{short:true,minWeight:-.3,maxWeight:1,excluded:[]}}};
 const payload=serializeComparison({data,model,current,saved:[],sequence:0,capital:1e6}),original=structuredClone(payload);assert.throws(()=>restoreComparison(payload),/превышает новые лимиты/);assert.deepEqual(payload,original);
});
