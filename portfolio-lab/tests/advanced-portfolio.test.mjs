import test from 'node:test';
import assert from 'node:assert/strict';
import {estimate,createOptimizer,metrics,dot,variance} from '../dist/engine.js';
import {weightBounds,exposures,exposureLimits} from '../dist/constrained-optimizer.js';
import {runBacktest,runRollingBacktest} from '../dist/backtest.js';
import {serializeComparison,restoreComparison,evaluatePortfolio,reportPortfolio} from '../dist/comparison.js';
import {officialData} from './fixtures.mjs';
const close=(a,b,e=1e-7)=>assert.ok(Math.abs(a-b)<e,`${a} != ${b}`);
const check=(w,b)=>{close(w.reduce((a,b)=>a+b,0),1);w.forEach((v,i)=>assert.ok(v>=b.lower[i]-1e-8&&v<=b.upper[i]+1e-8));};
const diagonal=()=>({mu:[.1,.05],cov:[[.01,0],[0,.04]],stabilized:[[.01,0],[0,.04]]});
test('bounded QP agrees with analytical unconstrained and capped two-asset solutions',()=>{
 const m=diagonal(),o=createOptimizer(m,{short:true,minWeight:-.5,maxWeight:1});close(o.global.weights[0],.8);
 close(o.at(.09).weights[0],.8);close(o.at(.075).weights[0],.5);
 const capped=createOptimizer(m,{minWeight:.2,maxWeight:.6});close(capped.global.weights[0],.6);close(capped.max,.08);assert.throws(()=>capped.at(.081),/недостижима/);
});
test('short positions improve the objective when allowed and preserve net capital',()=>{
 const m={mu:[.2,-.2,.02],cov:[[.1,0,0],[0,.1,0],[0,0,.01]],stabilized:[[.1,0,0],[0,.1,0],[0,0,.01]]},constraints={short:true,minWeight:-.3,maxWeight:1};
 const short=createOptimizer(m,constraints).solve('markowitz',{lambda:1}),long=createOptimizer(m).solve('markowitz',{lambda:1});
 assert.ok(short.weights[1]<0);assert.ok(short.return-short.objective>long.return-long.objective);check(short.weights,weightBounds(3,constraints));
});
test('all criteria and frontier obey minimum, maximum and exclusions; constraints reject impossible cases',()=>{
 const m=estimate(officialData(),12,{covariance:'oas'}),constraints={short:true,minWeight:-.2,maxWeight:.4,excluded:[0,2,4]},o=createOptimizer(m,constraints),b=weightBounds(9,constraints);
 for(const p of [...o.frontier,...['markowitz','sharpe','risk','return'].map(mode=>o.solve(mode,{targetReturn:o.global.return,targetRisk:Math.max(.5,o.global.risk)}))]){check(p.weights,b);assert.ok(exposures(p.weights).short<=.25+1e-8);assert.ok(exposures(p.weights).gross<=1.5+1e-8);for(const i of constraints.excluded)assert.equal(p.weights[i],0);}
 assert.throws(()=>createOptimizer(m,{minWeight:.12}),/несовместимы/);assert.throws(()=>createOptimizer(m,{maxWeight:.1}),/несовместимы/);assert.throws(()=>createOptimizer(m,{minWeight:-.1}),/границы/);assert.throws(()=>createOptimizer(m,{excluded:[0,0]}),/границы/);
 assert.throws(()=>createOptimizer(m,{minWeight:1/9,maxWeight:1/9}),/меньше максимального/);
 const allFixed=createOptimizer(m,{minWeight:0,maxWeight:1/9});check(allFixed.global.weights,allFixed.bounds);close(allFixed.frontier.at(-1).return,allFixed.global.return);
});
test('bounded solver cannot be beaten by independent random feasible portfolios',()=>{
 const m=estimate(officialData(),12,{covariance:'oas'}),options={short:true,minWeight:-.2,maxWeight:.4,excluded:[3]},o=createOptimizer(m,options),solution=o.solve('markowitz',{lambda:2});
 let seed=44;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
 for(let k=0;k<20000;k++){const w=Array.from({length:9},()=>-.2+random()*.6);w[3]=0;w[8]=1-w.slice(0,8).reduce((a,b)=>a+b,0);if(w[8]<-.2||w[8]>.4||exposures(w).short>.25)continue;assert.ok(dot(w,m.mu)-2*variance(w,m.stabilized)<=solution.return-2*solution.objective+1e-7);}
});
test('OAS implements the empirical-covariance formula, regularizes singular series and preserves means',()=>{
 const data=officialData(),sample=estimate(data),oas=estimate(data,12,{covariance:'oas'});assert.deepEqual(oas.mu,sample.mu);assert.deepEqual(oas.returns,sample.returns);assert.ok(oas.shrinkage>0&&oas.shrinkage<=1);
 const T=oas.returns.length,p=oas.mu.length,S=sample.cov.map(r=>r.map(v=>v*(T-1)/T)),center=S.reduce((s,r,i)=>s+r[i],0)/p,alpha=S.flat().reduce((s,v)=>s+v*v,0)/(p*p),rho=Math.min(1,(alpha+center*center)/((T+1)*(alpha-center*center/p)));
 close(oas.shrinkage,rho,1e-12);oas.cov.forEach((r,i)=>r.forEach((v,j)=>close(v,(1-rho)*S[i][j]+(i===j?rho*center:0),1e-12)));
 const identical=structuredClone(data);identical.rows.forEach(r=>r.values=r.values.map((v,i)=>i?r.values[1]:v));const robust=estimate(identical,12,{covariance:'oas'});assert.ok(robust.shrinkage>0);assert.ok(createOptimizer(robust,{short:true}).global.weights.every(Number.isFinite));
});
test('signed portfolio paths include negative returns contributions and reject bankruptcy',()=>{
 const m={mu:[.12,.24],cov:[[.01,0],[0,.02]],frequency:12,dates:['2020-01-31','2020-02-29','2020-03-31'],returns:[[.1,.2],[.2,.1]]};const w=[1.2,-.2],s=metrics(m,w);close(s.wealth[1],1.08);close(s.wealth[2],1.08*1.22);
 assert.throws(()=>metrics({...m,returns:[[0,6],[0,0]]},w),/неположительным/);
});
test('holdout applies constraints and training-only OAS while reporting actual sample volatility',()=>{
 const constraints={short:true,minWeight:-.2,maxWeight:.4,excluded:[1,3]},r=runBacktest(officialData(),{constraints,covariance:'oas'});assert.equal(r.trainModel.covariance,'oas');assert.equal(r.testModel.covariance,'sample');for(const p of [...r.portfolios,r.benchmark])check(p.weights,weightBounds(9,constraints));
});
test('rolling windows are chronological, complete and match manually compounded held-out returns',()=>{
 const data=officialData(),options={window:24,step:5,covariance:'oas',constraints:{short:true,minWeight:-.2,maxWeight:.4,excluded:[1]},modes:['markowitz']},r=runRollingBacktest(data,options),p=r.portfolios[0];assert.equal(r.errors.length,0);assert.equal(p.returns.length,data.rows.length-1-24);assert.equal(r.testDates.length,p.returns.length+1);
 let wealth=1,offset=24;for(const fold of p.folds){assert.equal(fold.trainTo,fold.boundary);assert.ok(fold.trainTo<fold.testFrom);check(fold.weights,weightBounds(9,options.constraints));const end=data.rows.findIndex(row=>row.date===fold.testTo);for(let i=offset+1;i<=end;i++){const a=data.rows[i-1],b=data.rows[i];wealth*=1+fold.weights.reduce((sum,w,j)=>sum+w*((b.values[j+1]/a.values[j+1])/(b.cpi/a.cpi)-1),0);close(p.testStats.wealth[i-24],wealth);}offset=end;}
 assert.equal(offset,data.rows.length-1);close(p.testStats.totalReturn,wealth-1);assert.ok(r.windows.at(-1).testTo===data.rows.at(-1).date);
 const future=structuredClone(data),firstBoundary=options.window;future.rows.slice(firstBoundary+1).forEach((row,i)=>{row.cpi*=1+(i+1)*.02;row.values[1]*=1+(i+1)*.05;});const altered=runRollingBacktest(future,options);assert.deepEqual(altered.portfolios[0].folds[0],p.folds[0]);assert.notEqual(altered.portfolios[0].testStats.totalReturn,p.testStats.totalReturn);
});
test('rolling rejects invalid windows and removes an entire criterion if any fold is infeasible',()=>{
 const data=officialData();assert.throws(()=>runRollingBacktest(data,{window:500}),/12 месяцев/);assert.throws(()=>runRollingBacktest(data,{step:0}),/шаг/);const r=runRollingBacktest(data,{window:24,settings:{targetReturn:100},modes:['markowitz','risk']});assert.equal(r.portfolios.length,1);assert.equal(r.errors[0].mode,'risk');assert.equal(r.benchmark.returns.length,r.testDates.length-1);
});
test('short constraints and estimator survive saved sets and common-period frontier recalculation',()=>{
 const data=officialData(),constraints={short:true,minWeight:-.2,maxWeight:.4,excluded:[1]},model=estimate(data,12,{covariance:'oas',excluded:constraints.excluded}),optimizer=createOptimizer(model,constraints),settings={rf:0,nominalRf:.08,lambda:3,constraints,covariance:'oas'},current={...optimizer.solve('markowitz'),id:'current',name:'Марковиц',mode:'markowitz',settings};
 const state={data,model,current,saved:[{...current,id:'p1',ordinal:1,snapshot:{data,model,frontier:optimizer.frontier}}],capital:1e6,sequence:1};const payload=serializeComparison(state),restored=restoreComparison(payload);assert.deepEqual(restored.current.weights,current.weights);assert.deepEqual(restored.current.settings.constraints,constraints);assert.equal(restored.model.covariance,'oas');
 const period={from:model.dates[10],to:model.dates.at(-1)},evaluated=reportPortfolio(restored.saved[0],restored,period);assert.equal(evaluated.snapshot.model.covariance,'oas');evaluated.snapshot.frontier.forEach(p=>check(p.weights,weightBounds(9,constraints)));
 const invalid=structuredClone(payload);invalid.current.settings.constraints.short=false;assert.throws(()=>restoreComparison(invalid));
});

test('excluded asset observations cannot affect OAS, optimizer or rolling investment paths',()=>{
 const data=officialData(),excluded=[0,3],options={covariance:'oas',excluded},constraints={short:true,minWeight:-.2,maxWeight:.4,excluded},altered=structuredClone(data);altered.rows.forEach((r,i)=>{r.values[1]*=1+i*.4;r.values[4]*=1+i*.2;});
 const a=estimate(data,12,options),b=estimate(altered,12,options);close(a.shrinkage,b.shrinkage,1e-12);const wa=createOptimizer(a,constraints).solve('markowitz').weights,wb=createOptimizer(b,constraints).solve('markowitz').weights;wa.forEach((w,i)=>close(w,wb[i],1e-8));
 const ra=runRollingBacktest(data,{window:24,step:6,modes:['markowitz'],constraints,covariance:'oas'}),rb=runRollingBacktest(altered,{window:24,step:6,modes:['markowitz'],constraints,covariance:'oas'});close(ra.portfolios[0].testStats.totalReturn,rb.portfolios[0].testStats.totalReturn,1e-8);
});
