// CPI and M2 are explanatory series, never assets in the optimized portfolio.
export function macroSeries(data) {
  const rows=data.rows,first=rows[0];
  return {
    dates:rows.map(row=>row.date),
    monthlyInflation:rows.map((row,i)=>i?row.cpi/rows[i-1].cpi-1:null),
    annualInflation:rows.map((row,i)=>i>=12?row.cpi/rows[i-12].cpi-1:null),
    accumulatedInflation:rows.map(row=>row.cpi/first.cpi-1),
    moneySupply:rows.map(row=>row.values[0]),
    moneyGrowth:rows.map(row=>row.values[0]/first.values[0]-1)
  };
}
