import test from 'node:test';
import assert from 'node:assert/strict';
import {demoData,parseTable,parseDate,estimate,createOptimizer,metrics,dot,variance} from '../dist/engine.js';
const close=(a,b,tol=1e-7)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);
const demo=demoData(),model=estimate(demo),opt=createOptimizer(model);
test('inflation adjustment uses price ratios, including zero nominal cash returns',()=>{
  const d=demoData();d.rows.forEach((r,t)=>{r.values=Array(10).fill(100*Math.pow(1.01,t));r.cpi=100*Math.pow(1.005,t);});
  const m=estimate(d);close(m.returns[0][0],1.01/1.005-1);close(m.mu[0],12*(1.01/1.005-1));
  const cash=estimate(d,12,true);close(cash.returns[0][0],1/1.005-1);assert.equal(cash.names[0],'Рублёвый остаток');
});
test('minimum variance matches the analytic answer for diagonal covariance',()=>{
  const cov=Array.from({length:10},(_,i)=>Array.from({length:10},(_,j)=>i===j?.01*(i+1):0));
  const m={mu:Array.from({length:10},(_,i)=>.01*(i+1)),cov,stabilized:cov};
  const o=createOptimizer(m),sum=Array.from({length:10},(_,i)=>1/(i+1)).reduce((s,v)=>s+v,0);
  o.global.weights.forEach((v,i)=>close(v,1/(i+1)/sum));
});
test('all four criteria satisfy budget, positivity and their constraints',()=>{
  const rf=.01,targetReturn=(opt.global.return+Math.max(...model.mu))/2,targetRisk=opt.global.risk*2;
  for(const mode of ['markowitz','sharpe','risk','return']) {
    const p=opt.solve(mode,{rf,targetReturn,targetRisk,lambda:3});
    close(p.weights.reduce((s,v)=>s+v,0),1);assert.ok(p.weights.every(v=>v>=0));
    close(p.return,dot(p.weights,model.mu));close(p.risk**2,variance(p.weights,model.cov));
    if(mode==='risk')assert.ok(p.return>=targetReturn-1e-8);
    if(mode==='return')assert.ok(p.risk<=targetRisk+1e-8);
  }
});
test('Sharpe and Markowitz exceed all sampled frontier objective values',()=>{
  const rf=.01,lambda=4,sharpe=opt.solve('sharpe',{rf}),mark=opt.solve('markowitz',{lambda});
  for(const p of opt.frontier) {
    assert.ok((sharpe.return-rf)/sharpe.risk >= (p.return-rf)/p.risk-1e-7);
    assert.ok(mark.return-lambda*mark.objective >= p.return-lambda*p.objective-1e-7);
  }
});
test('frontier starts at global minimum and includes maximum return endpoint',()=>{
  close(opt.frontier[0].risk,opt.global.risk);close(opt.frontier.at(-1).return,Math.max(...model.mu));
  for(let i=1;i<opt.frontier.length;i++){assert.ok(opt.frontier[i].return>=opt.frontier[i-1].return-1e-8);assert.ok(opt.frontier[i].risk>=opt.frontier[i-1].risk-1e-8);}
});
test('infeasible targets and nonpositive excess returns fail explicitly',()=>{
  assert.throws(()=>opt.solve('risk',{targetReturn:Math.max(...model.mu)+.1}),/недостижима/);
  assert.throws(()=>opt.solve('return',{targetRisk:opt.global.risk/2}),/минимально/);
  assert.throws(()=>opt.solve('sharpe',{rf:Math.max(...model.mu)+.1}),/положительным/);
  assert.throws(()=>opt.solve('markowitz',{lambda:-1}),/параметры/);
});
test('realized wealth includes initial capital and recovery uses calendar dates',()=>{
  const returns=[-.2,.1,1/.88-1,-.1,-.1];
  const m={returns:returns.map(r=>Array(10).fill(r)),mu:Array(10).fill(.1),cov:Array.from({length:10},()=>Array(10).fill(.01)),frequency:12,dates:['2020-01-31','2020-02-29','2020-03-31','2020-04-30','2020-05-31','2020-06-30']};
  const s=metrics(m,Array(10).fill(.1),.02,1000);
  close(s.wealth[0],1);close(s.wealth[3],1);close(s.wealth.at(-1),.81);close(s.maxDrawdown,-.2);close(s.longestRecovery,90);close(s.openRecovery,61);close(s.expectedIncome,100);close(s.totalReturn,-.19);
});
test('a constant path has no drawdown and undefined Sharpe',()=>{
  const d=demoData();d.rows.forEach(r=>{r.values=Array(10).fill(100);r.cpi=100;});const m=estimate(d);const o=createOptimizer(m);const s=metrics(m,o.global.weights);
  close(s.totalReturn,0);close(s.maxDrawdown,0);assert.equal(s.sharpe,null);assert.equal(s.longestRecovery,0);assert.equal(s.openRecovery,0);
});
test('Excel schema roundtrip and localized numeric cells',()=>{
  const table=[['Дата','ИПЦ',...demo.names],...demo.rows.map(r=>[r.date,r.cpi,...r.values])];
  table[1][2]='58 000,5';const d=parseTable(table);close(d.rows[0].values[0],58000.5);assert.equal(d.names.length,10);
  assert.equal(parseDate('31.01.2020'),'2020-01-31');assert.equal(parseDate(43861),'2020-01-31');
  assert.throws(()=>parseDate('2020-02-31'),/Некорректная/);
});
test('import rejects gaps, duplicate dates, empty values, duplicate names and extra columns',()=>{
  const table=()=>[['Дата','ИПЦ',...demo.names],...demo.rows.map(r=>[r.date,r.cpi,...r.values])];
  let t=table();t[2][0]=t[1][0];assert.throws(()=>parseTable(t),/возрастать/);
  t=table();t[1][3]=null;assert.throws(()=>parseTable(t),/отсутствует/);
  t=table();t[0][3]=t[0][2];assert.throws(()=>parseTable(t),/уникальными/);
  t=table();t[2].push(15);assert.throws(()=>parseTable(t),/12 столбцов/);
  const d=demoData();d.rows.splice(2,1);assert.throws(()=>estimate(d,12),/последовательный месяц/);
});
test('independent random feasible portfolios never beat optimized objectives',()=>{
  const lambda=3,rf=.01,mark=opt.solve('markowitz',{lambda}),sharpe=opt.solve('sharpe',{rf});
  let seed=42;const random=()=>{seed=(1664525*seed+1013904223)>>>0;return(seed+.5)/4294967296;};
  for(let i=0;i<2000;i++) {
    const v=Array.from({length:10},()=>-Math.log(random())),sum=v.reduce((s,x)=>s+x,0),w=v.map(x=>x/sum),ret=dot(w,model.mu),risk=Math.sqrt(variance(w,model.cov));
    assert.ok(mark.return-lambda*mark.objective>=ret-lambda*variance(w,model.stabilized)-1e-7);
    assert.ok((sharpe.return-rf)/sharpe.risk>=(ret-rf)/risk-1e-7);
  }
});

test('known wealth path has correct annual return, volatility and unfinished maximum recovery',()=>{
  const levels=[100,80,100,90,81,81,81,81,81,81,81,81,81];
  const rows=levels.map((v,i)=>({date:new Date(Date.UTC(2020,i+1,0)).toISOString().slice(0,10),cpi:100,values:Array(10).fill(v)}));
  const m=estimate({names:demo.names,rows}),s=metrics(m,Array(10).fill(.1),0,1000000);
  close(s.expectedReturn,-.15);close(s.expectedIncome,-150000);
  close(s.risk,Math.sqrt((.1225-12*.0125**2)/11*12));
  close(s.cagr,-.19);close(s.totalReturn,-.19);close(s.maxDrawdown,-.2);
  assert.equal(s.longestRecovery,60);assert.equal(s.openRecovery,306);assert.equal(s.maxRecovery,306);assert.equal(s.recoveryIncomplete,true);
});
test('completed maximum recovery remains exact when an ongoing episode is shorter',()=>{
  const returns=[-.2,.1,1/.88-1,-.1,-.1];
  const m={returns:returns.map(r=>Array(10).fill(r)),mu:Array(10).fill(.1),cov:Array.from({length:10},()=>Array(10).fill(.01)),frequency:12,dates:['2020-01-31','2020-02-29','2020-03-31','2020-04-30','2020-05-31','2020-06-30']};
  const s=metrics(m,Array(10).fill(.1));
  assert.equal(s.maxRecovery,90);assert.equal(s.recoveryIncomplete,false);assert.equal(s.openRecovery,61);
});
test('numerical overflow is rejected instead of producing infinite curves',()=>{
  const m={returns:Array.from({length:100},()=>Array(10).fill(1e10)),mu:Array(10).fill(.1),cov:Array.from({length:10},()=>Array(10).fill(.01)),frequency:12,dates:Array(101).fill('2020-01-01')};
  assert.throws(()=>metrics(m,Array(10).fill(.1)),/числовой диапазон/);
  assert.throws(()=>metrics(model,Array(10).fill(.1),0,Infinity),/конечными/);
});
test('import limit is exactly 5000 observations and missing header cells are rejected',()=>{
  const table=[['Дата','ИПЦ',...demo.names],...Array.from({length:5000},(_,i)=>[new Date(Date.UTC(1900,i,1)).toISOString().slice(0,10),100,...Array(10).fill(100)])];
  assert.equal(parseTable(table).rows.length,5000);
  table.push(['2500-01-01',100,...Array(10).fill(100)]);assert.throws(()=>parseTable(table),/5000/);
  const missing=[['Дата','ИПЦ',...demo.names],...demo.rows.map(r=>[r.date,r.cpi,...r.values])];delete missing[0][3];assert.throws(()=>parseTable(missing),/непустыми/);
});
