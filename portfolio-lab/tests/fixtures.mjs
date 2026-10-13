import {readFileSync} from 'node:fs';
const snapshot=JSON.parse(readFileSync(new URL('../dist/data/market-data.json',import.meta.url),'utf8'));
export function officialData(){const data=structuredClone(snapshot);data.rows=data.rows.filter(row=>row.date>='2019-01-31'&&row.date<='2026-01-31');data.period={from:'2019-01',to:'2026-01'};data.official=true;return data;}
export function officialSnapshot(){return structuredClone(snapshot);}
