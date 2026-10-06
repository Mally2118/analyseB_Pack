export const dot = (a,b) => a.reduce((s,v,i)=>s+v*b[i],0);
export const mean = a => a.reduce((s,v)=>s+v,0)/a.length;
export const variance = (w,c) => dot(w,c.map(row=>dot(row,w)));
const day = 86400000;

export function demoData() {
  let seed=62841;
  const rand=()=>{seed=(1664525*seed+1013904223)>>>0;return (seed+.5)/4294967296;};
  const normal=()=>Math.sqrt(-2*Math.log(rand()))*Math.cos(2*Math.PI*rand());
  const names=['Рублёвая масса М2','Золото','Доллар США','Евро','Юань','Индекс Мосбиржи','ОФЗ / RGBITR','Индекс недвижимости','Серебро','Индекс S&P 500'];
  let values=[58000,3200,64,71,9.2,3000,100,100,38,190000],cpi=100;
  const rows=[];
  for(let t=0;t<85;t++) {
    const date=new Date(Date.UTC(2019+Math.floor(t/12),t%12+1,0)).toISOString().slice(0,10);
    if(t) {
      const shock=t===38?.15:t===39?-.08:t===50?-.06:0;
      const fx=.018*normal()+shock, equity=.038*normal()-shock*1.3;
      const rates=[.009+.005*normal(),.011+.5*fx+.031*normal(),.004+fx,.003+.92*fx+.01*normal(),.003+.75*fx+.008*normal(),.012+equity,.007+.009*normal()-shock*.12,.008+.008*normal()-shock*.08,.009+.6*fx+.045*normal(),.012+.6*fx+.034*normal()];
      values=values.map((v,i)=>v*(1+rates[i]));
      cpi*=1+Math.max(.0003,.004+.0015*normal()+(t===38?.025:0));
    }
    rows.push({date,cpi,values:[...values]});
  }
  return {names,rows,source:'Учебный пример · синтетические данные',demo:true};
}

export function parseDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0,10);
  if(typeof value==='number' && value>1 && value<100000) return new Date(Date.UTC(1899,11,30)+Math.floor(value)*day).toISOString().slice(0,10);
  if(typeof value!=='string') throw Error('Дата должна быть датой Excel или строкой ГГГГ-ММ-ДД.');
  const s=value.trim();
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(s) || /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s)?.slice().map((v,i,a)=>i===1?a[3]:i===3?a[1]:v);
  if(!match) throw Error(`Неверный формат даты: ${s}. Используйте ГГГГ-ММ-ДД.`);
  const iso=`${match[1]}-${match[2]}-${match[3]}`;
  const d=new Date(iso+'T00:00:00Z');
  if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==iso) throw Error(`Некорректная дата: ${s}.`);
  return iso;
}

export function parseTable(table) {
  const clean=table.filter(row=>row.some(v=>v!==null&&v!==undefined&&v!==''));
  if(clean.length<14) throw Error('Нужно минимум 13 наблюдений уровней (12 периодов доходности).');
  if(clean.length>5001) throw Error('Максимум 5000 наблюдений.');
  const headers=clean[0];
  if(headers.length!==12 || clean.slice(1).some(r=>r.length>12)) throw Error('Ожидаются 12 столбцов: Дата, ИПЦ и ровно 10 индикаторов.');
  if(!/^(дата|date)$/i.test(String(headers[0]).trim())||!/^(ипц|cpi)$/i.test(String(headers[1]).trim())) throw Error('Первые два заголовка должны быть «Дата» и «ИПЦ».');
  const names=Array.from(headers.slice(2),v=>String(v??'').trim());
  if(names.some(n=>!n||n.length>80)||new Set(names).size!==10) throw Error('Имена десяти индикаторов должны быть уникальными, непустыми, до 80 символов.');
  const number=(value,label)=>{
    const s=typeof value==='string'?value.trim().replace(/\s/g,'').replace(',','.'):value;
    if(s===''||s===null||s===undefined||typeof s==='boolean') throw Error(`${label}: отсутствует числовое значение.`);
    const v=Number(s);
    if(!Number.isFinite(v)||v<=0) throw Error(`${label}: требуется положительное конечное число.`);
    return v;
  };
  const rows=clean.slice(1).map((row,i)=>({date:parseDate(row[0]),cpi:number(row[1],`Строка ${i+2}, ИПЦ`),values:names.map((n,j)=>number(row[j+2],`Строка ${i+2}, ${n}`))}));
  for(let i=1;i<rows.length;i++) if(rows[i].date<=rows[i-1].date) throw Error('Даты должны строго возрастать, без повторов.');
  return {names,rows,demo:false,source:'Загруженный Excel'};
}

export function estimate(data,frequency=12,cash=false) {
  const {rows}=data;
  if(rows.length<13) throw Error('Нужно не менее 13 наблюдений.');
  if(![1,12,252].includes(frequency)) throw Error('Неизвестная периодичность.');
  if(frequency===12) for(let i=1;i<rows.length;i++) {
    const a=new Date(rows[i-1].date),b=new Date(rows[i].date);
    if(b.getUTCFullYear()*12+b.getUTCMonth()-(a.getUTCFullYear()*12+a.getUTCMonth())!==1) throw Error('Для месячных данных требуется один ряд на каждый последовательный месяц.');
  }
  if(frequency===1) for(let i=1;i<rows.length;i++) if(new Date(rows[i].date).getUTCFullYear()-new Date(rows[i-1].date).getUTCFullYear()!==1) throw Error('Для годовых данных нужны последовательные годы.');
  if(frequency===252) for(let i=1;i<rows.length;i++) if((new Date(rows[i].date)-new Date(rows[i-1].date))/day>7) throw Error('В дневных данных обнаружен разрыв более 7 дней. Проверьте периодичность.');
  const returns=rows.slice(1).map((row,t)=>row.values.map((value,j)=>((cash&&j===0?1:value/rows[t].values[j])/(row.cpi/rows[t].cpi))-1));
  if(returns.some(r=>r.some(v=>!Number.isFinite(v)||v<=-1)))throw Error('Изменения уровней слишком велики для устойчивого расчёта. Проверьте числа и единицы измерения.');
  const means=Array.from({length:10},(_,j)=>mean(returns.map(r=>r[j])));
  const mu=means.map(v=>v*frequency);
  const cov=means.map((_,i)=>means.map((__,j)=>returns.reduce((s,r)=>s+(r[i]-means[i])*(r[j]-means[j]),0)/(returns.length-1)*frequency));
  if(mu.some(v=>!Number.isFinite(v))||cov.some(r=>r.some(v=>!Number.isFinite(v))))throw Error('Не удалось оценить ковариацию: проверьте масштаб чисел.');
  // A tiny ridge makes singular / identical input series numerically solvable.
  const ridge=Math.max(1e-12,Math.max(...cov.map((r,i)=>r[i]))*1e-10);
  const stabilized=cov.map((r,i)=>r.map((v,j)=>v+(i===j?ridge:0)));
  const inflation=Math.pow(rows.at(-1).cpi/rows[0].cpi,frequency/(rows.length-1))-1;
  return {mu,cov,stabilized,returns,frequency,inflation,dates:rows.map(r=>r.date),names:data.names.map((n,i)=>cash&&i===0?'Рублёвый остаток':n)};
}

function inverse(a) {
  const n=a.length,m=a.map((row,i)=>[...row,...Array.from({length:n},(_,j)=>+(i===j))]);
  for(let k=0;k<n;k++) {
    let pivot=k;for(let i=k+1;i<n;i++) if(Math.abs(m[i][k])>Math.abs(m[pivot][k])) pivot=i;
    if(Math.abs(m[pivot][k])<1e-18) return null;
    [m[k],m[pivot]]=[m[pivot],m[k]];
    const div=m[k][k];for(let j=0;j<2*n;j++)m[k][j]/=div;
    for(let i=0;i<n;i++) if(i!==k) {const f=m[i][k];for(let j=0;j<2*n;j++)m[i][j]-=f*m[k][j];}
  }
  return m.map(row=>row.slice(n));
}

export function createOptimizer(model) {
  const {mu,stabilized:cov}=model,n=mu.length,subsets=[];
  let global=null;
  const pack=(weights)=>({weights,return:dot(weights,mu),risk:Math.sqrt(Math.max(0,variance(weights,model.cov))),objective:variance(weights,cov)});
  const valid=w=>w.every(v=>v>=-1e-8&&Number.isFinite(v));
  const expand=(ids,w)=>{const full=Array(n).fill(0),sum=w.reduce((s,v)=>s+Math.max(0,v),0);ids.forEach((id,i)=>full[id]=Math.max(0,w[i])/sum);return full;};
  for(let mask=1;mask<(1<<n);mask++) {
    const ids=Array.from({length:n},(_,i)=>i).filter(i=>mask&(1<<i));
    const inv=inverse(ids.map(i=>ids.map(j=>cov[i][j])));if(!inv)continue;
    const m=ids.map(i=>mu[i]),u=inv.map(row=>row.reduce((s,v)=>s+v,0)),v=inv.map(row=>dot(row,m));
    const A=u.reduce((s,x)=>s+x,0),B=dot(m,u),C=dot(m,v),D=A*C-B*B;
    const g=u.map(x=>x/A);
    if(valid(g)) {const p=pack(expand(ids,g));if(!global||p.objective<global.objective)global=p;}
    subsets.push({ids,m,u,v,A,B,C,D});
  }
  if(!global)throw Error('Не удалось построить портфель. Проверьте входные данные.');
  function at(target) {
    let best=null;
    for(const s of subsets) {
      let w;
      if(s.ids.length===1||Math.abs(s.D)<1e-13*s.A*Math.max(Math.abs(s.C),1e-12)) {
        if(Math.abs(s.B/s.A-target)>1e-8)continue;
        w=s.u.map(x=>x/s.A);
      } else w=s.u.map((x,i)=>(x*(s.C-s.B*target)+s.v[i]*(s.A*target-s.B))/s.D);
      if(!valid(w))continue;
      const p=pack(expand(s.ids,w));
      if(Math.abs(p.return-target)>1e-7)continue;
      if(!best||p.objective<best.objective)best=p;
    }
    if(!best)throw Error('Целевая доходность недостижима при весах от 0 до 100%.');
    return best;
  }
  const max=Math.max(...mu);
  const frontier=Array.from({length:65},(_,i)=>at(global.return+(max-global.return)*i/64));
  function maximize(fn) {
    let lo=global.return,hi=max;
    for(let i=0;i<55;i++) {
      const a=lo+(hi-lo)/3,b=hi-(hi-lo)/3;
      if(fn(at(a))<fn(at(b)))lo=a;else hi=b;
    }
    return [at((lo+hi)/2),global,at(max)].reduce((a,b)=>fn(a)>fn(b)?a:b);
  }
  function solve(mode,{lambda=3,rf=0,targetReturn=.10,targetRisk=.20}={}) {
    if(![lambda,rf,targetReturn,targetRisk].every(Number.isFinite)||lambda<0||rf<=-1||targetRisk<0) throw Error('Проверьте числовые параметры.');
    if(mode==='markowitz')return maximize(p=>p.return-lambda*p.objective);
    if(mode==='sharpe') {
      if(max<=rf)throw Error('Ни один индикатор не превышает безрисковую ставку. Портфель с положительным коэффициентом Шарпа недостижим.');
      return maximize(p=>p.risk<1e-10?(p.return>rf?Infinity:-Infinity):(p.return-rf)/p.risk);
    }
    if(mode==='risk')return targetReturn<=global.return?global:at(targetReturn);
    if(mode==='return') {
      if(targetRisk<global.risk-1e-8)throw Error(`Лимит риска ниже минимально достижимого (${(global.risk*100).toFixed(2)}%).`);
      if(at(max).risk<=targetRisk)return at(max);
      let lo=global.return,hi=max;
      for(let i=0;i<60;i++) {const mid=(lo+hi)/2;if(at(mid).risk<=targetRisk)lo=mid;else hi=mid;}
      return at(lo);
    }
    throw Error('Неизвестный критерий.');
  }
  return {global,frontier,solve,at};
}

export function metrics(model,weights,rf=0,capital=1000000) {
  if(weights.length!==10||weights.some(v=>!Number.isFinite(v)||v<0)||Math.abs(weights.reduce((s,v)=>s+v,0)-1)>1e-6) throw Error('Веса должны быть неотрицательными и в сумме равняться 100%.');
  if(!Number.isFinite(capital)||capital<=0||!Number.isFinite(rf))throw Error('Капитал и ставка должны быть конечными числами; капитал должен быть больше нуля.');
  const r=model.returns.map(row=>dot(row,weights));
  const wealth=[1];r.forEach(v=>wealth.push(wealth.at(-1)*(1+v)));
  if(wealth.some(v=>!Number.isFinite(v)||v<=0||!Number.isFinite(v*capital)))throw Error('Исторический капитал выходит за допустимый числовой диапазон. Проверьте уровни индикаторов.');
  let peak=1,peakIndex=0,maxDrawdown=0,longestRecovery=0,underwater=false;
  const drawdown=wealth.map((v,i)=>{
    if(v>=peak*(1-1e-12)) {
      if(underwater)longestRecovery=Math.max(longestRecovery,(new Date(model.dates[i])-new Date(model.dates[peakIndex]))/day);
      peak=v;peakIndex=i;underwater=false;
    }else underwater=true;
    const d=v/peak-1;maxDrawdown=Math.min(maxDrawdown,d);return d;
  });
  const openRecovery=underwater?(new Date(model.dates.at(-1))-new Date(model.dates[peakIndex]))/day:0;
  const expectedReturn=dot(weights,model.mu),risk=Math.sqrt(Math.max(0,variance(weights,model.cov)));
  const maxRecovery=Math.max(longestRecovery,openRecovery),recoveryIncomplete=underwater&&openRecovery>=longestRecovery;
  const cagr=Math.pow(wealth.at(-1),model.frequency/r.length)-1,expectedIncome=capital*expectedReturn;
  if(![expectedReturn,risk,cagr,expectedIncome].every(Number.isFinite))throw Error('Показатели выходят за допустимый числовой диапазон. Проверьте исходные уровни и периодичность.');
  return {expectedReturn,risk,sharpe:risk<1e-10?null:(expectedReturn-rf)/risk,cagr,totalReturn:wealth.at(-1)-1,maxDrawdown,longestRecovery,openRecovery,maxRecovery,recoveryIncomplete,wealth,drawdown,expectedIncome,finalCapital:capital*wealth.at(-1)};
}
