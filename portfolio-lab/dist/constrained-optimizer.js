// Convex active-set QP: sum(w)=1, optional return equality and per-asset bounds.
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
function linearSolve(matrix,rhs) {
  const a=matrix.map((r,i)=>[...r,rhs[i]]),n=a.length;
  for(let k=0;k<n;k++) {
    let p=k;for(let i=k+1;i<n;i++)if(Math.abs(a[i][k])>Math.abs(a[p][k]))p=i;
    if(Math.abs(a[p][k])<1e-12)return null;
    [a[k],a[p]]=[a[p],a[k]];const d=a[k][k];for(let j=k;j<=n;j++)a[k][j]/=d;
    for(let i=0;i<n;i++)if(i!==k){const f=a[i][k];for(let j=k;j<=n;j++)a[i][j]-=f*a[k][j];}
  }
  return a.map(r=>r[n]);
}
export function weightBounds(n,options={}) {
  if(!options||typeof options!=='object'||Array.isArray(options))throw Error('Проверьте границы весов.');
  const {short=false,minWeight=short?-.3:0,maxWeight=1,excluded=[]}=options;
  if(typeof short!=='boolean'||![minWeight,maxWeight].every(Number.isFinite)||maxWeight<=0||maxWeight>1||minWeight>maxWeight||minWeight< -maxWeight||!short&&minWeight<0||!Array.isArray(excluded)||new Set(excluded).size!==excluded.length||excluded.some(i=>!Number.isInteger(i)||i<0||i>=n))throw Error('Проверьте границы весов: максимум от 0 до 100%, минимум не выше максимума; отрицательный минимум доступен для коротких продаж.');
  const lower=Array.from({length:n},(_,i)=>excluded.includes(i)?0:minWeight),upper=Array.from({length:n},(_,i)=>excluded.includes(i)?0:maxWeight);
  if(dot(lower,Array(n).fill(1))>1+1e-10||dot(upper,Array(n).fill(1))<1-1e-10)throw Error('Ограничения несовместимы: сумма минимальных весов должна быть ≤ 100%, максимальных — ≥ 100%. Верните актив или измените границы.');
  return {lower,upper};
}
export function feasibleWeights(lower,upper) {
  let lo=Math.min(...lower)-1,hi=Math.max(...upper)+1;
  for(let k=0;k<80;k++){const mid=(lo+hi)/2,sum=lower.reduce((s,v,i)=>s+Math.max(v,Math.min(upper[i],mid)),0);if(sum<1)lo=mid;else hi=mid;}
  return lower.map((v,i)=>Math.max(v,Math.min(upper[i],(lo+hi)/2)));
}
function extreme(mu,lower,upper,sign=1) {
  const w=[...lower];let rest=1-w.reduce((a,b)=>a+b,0),cut=null;
  for(const i of mu.map((_,i)=>i).sort((a,b)=>sign*(mu[b]-mu[a]))) {
    const add=Math.min(rest,upper[i]-lower[i]);w[i]+=add;rest-=add;if(add>1e-12)cut=mu[i];if(rest<1e-12)break;
  }
  return {w,value:dot(w,mu),cut};
}
function qp(cov,lower,upper,seed,equality) {
  const n=lower.length,scale=Math.max(1e-8,...cov.map((r,i)=>upper[i]>lower[i]?r[i]:0)),H=cov.map(r=>r.map(v=>v/scale));
  const fixed=lower.map((v,i)=>Math.abs(upper[i]-v)<1e-12?i:-1).filter(i=>i>=0);
  const eq=[...equality.map(row=>row.map((v,i)=>fixed.includes(i)?0:v)),...fixed.map(i=>Array.from({length:n},(_,j)=>+(j===i)))];
  // Remove redundant rows, including all-fixed portfolios / constant returns.
  const independent=[];
  for(const row of eq){const next=[...independent,row];if(linearSolve(next.map(a=>next.map(b=>dot(a,b))),Array(next.length).fill(0)))independent.push(row);}
  let w=[...seed],working=[];
  for(let iteration=0;iteration<500;iteration++) {
    const A=[...independent,...working.map(b=>Array.from({length:n},(_,j)=>j===b.i?b.sign:0))],g=H.map(r=>dot(r,w)),m=A.length;
    const K=[...H.map((r,i)=>[...r,...A.map(a=>a[i])]),...A.map(a=>[...a,...Array(m).fill(0)])];
    const sol=linearSolve(K,[...g.map(v=>-v),...Array(m).fill(0)]);
    if(!sol)throw Error('Не удалось решить задачу с заданными ограничениями. Попробуйте shrinkage OAS.');
    const p=sol.slice(0,n);
    if(Math.max(...p.map(Math.abs))<1e-9) {
      let index=-1,worst=-1e-8;working.forEach((_,i)=>{const v=sol[n+independent.length+i];if(v<worst){worst=v;index=i;}});
      if(index<0)return w.map((v,i)=>Math.max(lower[i],Math.min(upper[i],Math.abs(v)<1e-12?0:v)));
      working.splice(index,1);continue;
    }
    let alpha=1,block=null;
    for(let i=0;i<n;i++)if(!fixed.includes(i)&&!working.some(b=>b.i===i)) {
      const step=p[i]>1e-12?(upper[i]-w[i])/p[i]:p[i]<-1e-12?(lower[i]-w[i])/p[i]:Infinity;
      if(step<alpha-1e-12){alpha=Math.max(0,step);block={i,sign:p[i]>0?1:-1};}
    }
    w=w.map((v,i)=>v+alpha*p[i]);
    if(block)working.push(block);
  }
  throw Error('Оптимизация не сошлась. Измените ограничения или выберите shrinkage OAS.');
}
export function boundedOptimizer(model,options) {
  const {mu,stabilized:cov}=model,n=mu.length,{lower,upper}=weightBounds(n,options),ones=Array(n).fill(1);
  const pack=weights=>({weights,return:dot(weights,mu),risk:Math.sqrt(Math.max(0,dot(weights,model.cov.map(r=>dot(r,weights))))),objective:dot(weights,cov.map(r=>dot(r,weights)))});
  const low=extreme(mu,lower,upper,-1),high=extreme(mu,lower,upper),global=pack(qp(cov,lower,upper,feasibleWeights(lower,upper),[ones])),cache=new Map();
  function at(target) {
    if(target<low.value-1e-8||target>high.value+1e-8)throw Error('Целевая доходность недостижима при заданных ограничениях весов.');
    target=Math.max(low.value,Math.min(high.value,target));if(cache.has(target))return cache.get(target);
    let w;
    if(high.value-low.value<1e-10)w=global.weights;
    else if(Math.abs(target-high.value)<1e-10||Math.abs(target-low.value)<1e-10) {
      const end=Math.abs(target-high.value)<1e-10?high:low,sign=end===high?1:-1;
      const l=lower.map((v,i)=>sign*(mu[i]-end.cut)>1e-10?upper[i]:v),u=upper.map((v,i)=>sign*(mu[i]-end.cut)<-1e-10?lower[i]:v);
      w=qp(cov,l,u,end.w,[ones]);
    } else {
      const f=(target-low.value)/(high.value-low.value),seed=low.w.map((v,i)=>v*(1-f)+high.w[i]*f);
      const muScale=Math.max(1e-4,...mu.map((v,i)=>upper[i]>lower[i]?Math.abs(v):0));w=qp(cov,lower,upper,seed,[ones,mu.map(v=>v/muScale)]);
    }
    const result=pack(w);if(Math.abs(result.return-target)>1e-7||Math.abs(w.reduce((a,b)=>a+b,0)-1)>1e-7)throw Error('Не удалось соблюсти ограничения весов.');cache.set(target,result);return result;
  }
  const frontier=Array.from({length:65},(_,i)=>at(global.return+(high.value-global.return)*i/64));
  function maximize(fn) {
    let lo=global.return,hi=high.value;for(let k=0;k<45;k++){const a=lo+(hi-lo)/3,b=hi-(hi-lo)/3;if(fn(at(a))<fn(at(b)))lo=a;else hi=b;}
    return [global,at(high.value),at((lo+hi)/2)].reduce((a,b)=>fn(a)>fn(b)?a:b);
  }
  function solve(mode,{lambda=3,rf=0,targetReturn=.1,targetRisk=.2}={}) {
    if(![lambda,rf,targetReturn,targetRisk].every(Number.isFinite)||lambda<0||rf<=-1||targetRisk<0)throw Error('Проверьте числовые параметры.');
    if(mode==='markowitz')return maximize(p=>p.return-lambda*p.objective);
    if(mode==='sharpe'){if(high.value<=rf)throw Error('Портфель с положительным коэффициентом Шарпа недостижим.');return maximize(p=>p.risk<1e-10?(p.return>rf?Infinity:-Infinity):(p.return-rf)/p.risk);}
    if(mode==='risk')return targetReturn<=global.return?global:at(targetReturn);
    if(mode==='return'){
      if(targetRisk<global.risk-1e-8)throw Error(`Лимит риска ниже минимально достижимого (${(global.risk*100).toFixed(2)}%).`);
      if(at(high.value).risk<=targetRisk)return at(high.value);let lo=global.return,hi=high.value;
      for(let k=0;k<50;k++){const mid=(lo+hi)/2;if(at(mid).risk<=targetRisk)lo=mid;else hi=mid;}return at(lo);
    }
    throw Error('Неизвестный критерий.');
  }
  return {global,frontier,solve,at,max:high.value,bounds:{lower,upper}};
}
