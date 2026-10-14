// Convex active-set QP: net exposure, return equality, box and total-short bounds.
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
  if(Number.isFinite(minWeight)&&Number.isFinite(maxWeight)&&minWeight>=maxWeight)throw Error('Минимальный вес одного актива должен быть меньше максимального.');
  if(typeof short!=='boolean'||![minWeight,maxWeight].every(Number.isFinite)||maxWeight<=0||maxWeight>1||minWeight>=maxWeight||minWeight< -maxWeight||!short&&minWeight<0||!Array.isArray(excluded)||new Set(excluded).size!==excluded.length||excluded.some(i=>!Number.isInteger(i)||i<0||i>=n))throw Error('Проверьте границы весов: максимум от 0 до 100%, минимум не выше максимума; отрицательный минимум доступен для коротких продаж.');
  const lower=Array.from({length:n},(_,i)=>excluded.includes(i)?0:minWeight),upper=Array.from({length:n},(_,i)=>excluded.includes(i)?0:maxWeight);
  if(dot(lower,Array(n).fill(1))>1+1e-10||dot(upper,Array(n).fill(1))<1-1e-10)throw Error('Ограничения несовместимы: сумма минимальных весов должна быть ≤ 100%, максимальных — ≥ 100%. Верните актив или измените границы.');
  const {shortCap}=exposureLimits(options);
  if(shortCap===0)for(let i=0;i<n;i++)lower[i]=Math.max(0,lower[i]);
  return {lower,upper};
}
export function exposures(weights) {
  const long=weights.reduce((s,w)=>s+Math.max(0,w),0),short=weights.reduce((s,w)=>s+Math.max(0,-w),0);
  return {long,short,net:weights.reduce((s,w)=>s+w,0),gross:weights.reduce((s,w)=>s+Math.abs(w),0)};
}
export function exposureLimits({short=false,grossLimit=1.5,shortLimit=.25}={}) {
  if(short&&(!Number.isFinite(grossLimit)||grossLimit<1))throw Error('Максимальная валовая экспозиция не может быть меньше 100%.');
  if(short&&(!Number.isFinite(shortLimit)||shortLimit<0))throw Error('Максимальная суммарная короткая позиция не может быть отрицательной.');
  return {grossLimit:short?grossLimit:1,shortLimit:short?shortLimit:0,shortCap:short?Math.min(shortLimit,(grossLimit-1)/2):0};
}
// Short(w)=max over subsets J of -sum(w_j). Every facet is linear, and together
// they are exactly equivalent to Short(w)<=cap. Net=1 implies Gross=1+2*Short.
function shortFacets(lower,cap) {
  if(!Number.isFinite(cap)||cap<=0)return [];
  const ids=lower.flatMap((v,i)=>v<0?[i]:[]),facets=[];
  for(let mask=1;mask<2**ids.length;mask++) {
    const row=Array(lower.length).fill(0);let possible=0;
    ids.forEach((id,k)=>{if(mask&(1<<k)){row[id]=-1;possible-=lower[id];}});
    if(possible>cap+1e-12)facets.push({row,bound:cap});
  }
  return facets;
}
export function feasibleWeights(lower,upper) {
  let lo=Math.min(...lower)-1,hi=Math.max(...upper)+1;
  for(let k=0;k<80;k++){const mid=(lo+hi)/2,sum=lower.reduce((s,v,i)=>s+Math.max(v,Math.min(upper[i],mid)),0);if(sum<1)lo=mid;else hi=mid;}
  return lower.map((v,i)=>Math.max(v,Math.min(upper[i],(lo+hi)/2)));
}
function boxExtreme(mu,lower,upper,sign) {
  const w=[...lower];let rest=1-w.reduce((a,b)=>a+b,0),cut=null;
  for(const i of mu.map((_,i)=>i).sort((a,b)=>sign*(mu[b]-mu[a]))) {
    const add=Math.min(rest,upper[i]-lower[i]);w[i]+=add;rest-=add;if(add>1e-12)cut=mu[i];if(rest<1e-12)break;
  }
  return {w,value:dot(w,mu),cut};
}
function extreme(mu,lower,upper,sign=1,cap=0) {
  if(cap>=lower.reduce((sum,v)=>sum+Math.max(0,-v),0)-1e-12)return boxExtreme(mu,lower,upper,sign);
  const scores=mu.map(v=>v*sign),ids=mu.map((_,i)=>i).sort((a,b)=>scores[b]-scores[a]);
  // Exact LP in long/short auxiliaries y,z: w=y-z; sum(y)-sum(z)=1,
  // sum(z)<=cap. Greedily add matched long/short capacity by marginal return.
  const y=lower.map(v=>Math.max(0,v)),z=Array(mu.length).fill(0);
  let rest=1-y.reduce((a,b)=>a+b,0),cut=null;
  for(const i of ids){const add=Math.min(rest,upper[i]-y[i]);y[i]+=add;rest-=add;if(add>1e-12)cut=mu[i];if(rest<1e-12)break;}
  let budget=cap;
  for(const i of ids)for(const j of [...ids].reverse()) {
    if(budget<=1e-12||scores[i]<=scores[j]+1e-12)continue;
    const add=Math.min(budget,upper[i]-y[i],Math.max(0,-lower[j])-z[j]);
    if(add>1e-12){y[i]+=add;z[j]+=add;budget-=add;}
  }
  const w=y.map((v,i)=>v-z[i]);return {w,value:dot(w,mu),cut};
}
function qp(cov,lower,upper,seed,equality,extra=[]) {
  const n=lower.length,scale=Math.max(1e-8,...cov.map((r,i)=>upper[i]>lower[i]?r[i]:0)),H=cov.map(r=>r.map(v=>v/scale));
  const fixed=lower.map((v,i)=>Math.abs(upper[i]-v)<1e-12?i:-1).filter(i=>i>=0);
  const eq=[...equality.map(row=>row.map((v,i)=>fixed.includes(i)?0:v)),...fixed.map(i=>Array.from({length:n},(_,j)=>+(j===i)))];
  // Remove redundant rows, including all-fixed portfolios / constant returns.
  const independent=[];
  for(const row of eq){const next=[...independent,row];if(linearSolve(next.map(a=>next.map(b=>dot(a,b))),Array(next.length).fill(0)))independent.push(row);}
  const inequalities=[...extra,...lower.flatMap((v,i)=>fixed.includes(i)?[]:[
    {row:Array.from({length:n},(_,j)=>j===i?-1:0),bound:-v},
    {row:Array.from({length:n},(_,j)=>+(j===i)),bound:upper[i]}
  ])];
  let w=[...seed],working=[];
  for(let iteration=0;iteration<500;iteration++) {
    const A=[...independent,...working.map(index=>inequalities[index].row)],g=H.map(r=>dot(r,w)),m=A.length;
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
    for(let i=0;i<inequalities.length;i++)if(!working.includes(i)) {
      const {row,bound}=inequalities[i],direction=dot(row,p);if(direction<=1e-11)continue;
      const step=(bound-dot(row,w))/direction;
      if(step<alpha-1e-12){alpha=Math.max(0,step);block=i;}
    }
    w=w.map((v,i)=>v+alpha*p[i]);
    if(block!==null)working.push(block);
  }
  throw Error('Оптимизация не сошлась. Измените ограничения или выберите shrinkage OAS.');
}
export function boundedOptimizer(model,options) {
  const {mu,stabilized:cov}=model,n=mu.length,{lower,upper}=weightBounds(n,options),ones=Array(n).fill(1),limits=exposureLimits(options),facets=shortFacets(lower,limits.shortCap);
  const pack=weights=>{
    const e=exposures(weights);
    if(Math.abs(e.net-1)>1e-7||e.short>limits.shortLimit+1e-7||e.gross>limits.grossLimit+1e-7||weights.some((w,i)=>w<lower[i]-1e-7||w>upper[i]+1e-7))throw Error('Не удалось соблюсти ограничения весов и экспозиции.');
    return {weights,return:dot(weights,mu),risk:Math.sqrt(Math.max(0,dot(weights,model.cov.map(r=>dot(r,weights))))),objective:dot(weights,cov.map(r=>dot(r,weights))),exposures:e};
  };
  const low=extreme(mu,lower,upper,-1,limits.shortCap),high=extreme(mu,lower,upper,1,limits.shortCap),global=pack(qp(cov,lower,upper,feasibleWeights(lower,upper),[ones],facets)),cache=new Map();
  function at(target) {
    if(target<low.value-1e-8||target>high.value+1e-8)throw Error('Целевая доходность недостижима при заданных ограничениях весов.');
    target=Math.max(low.value,Math.min(high.value,target));if(cache.has(target))return cache.get(target);
    let w;
    if(high.value-low.value<1e-10)w=global.weights;
    else if(!facets.length&&(Math.abs(target-high.value)<1e-10||Math.abs(target-low.value)<1e-10)) {
      const end=Math.abs(target-high.value)<1e-10?high:low,sign=end===high?1:-1;
      const l=lower.map((v,i)=>sign*(mu[i]-end.cut)>1e-10?upper[i]:v),u=upper.map((v,i)=>sign*(mu[i]-end.cut)<-1e-10?lower[i]:v);
      w=qp(cov,l,u,end.w,[ones]);
    } else {
      const f=(target-low.value)/(high.value-low.value),seed=low.w.map((v,i)=>v*(1-f)+high.w[i]*f);
      const muScale=Math.max(1e-4,...mu.map((v,i)=>upper[i]>lower[i]?Math.abs(v):0));w=qp(cov,lower,upper,seed,[ones,mu.map(v=>v/muScale)],facets);
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
