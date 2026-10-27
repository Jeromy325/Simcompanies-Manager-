'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const T=require(path.join(__dirname,'..','tools-core.js'));
const near=(a,b,eps=1e-6,msg)=>assert.ok(Math.abs(a-b)<=eps,`${msg||''} expected ${b} got ${a}`);
const H=3600000;

// ROI — reproduces the worked example published by simconomist.com's Building ROI calculator.
let r=T.roi({cost:100000,extraProfitPerHour:50,leadTimeHours:0,horizonDays:30});
assert.ok(r.ok); near(r.netOverHorizon,-64000); near(r.roiOverHorizon,-0.64); near(r.annualisedReturn,-0.64*365/30,1e-9);
near(r.annualisedReturn*100,-778.67,0.01,'annualised'); near(r.paybackHours,2000); near(r.paybackDays,2000/24);
assert.equal(r.paysBackWithinHorizon,false);
// lead time counts against the return and extends payback
r=T.roi({cost:1000,extraProfitPerHour:10,leadTimeHours:24,horizonDays:10});
near(r.netOverHorizon,10*(240-24)-1000); near(r.paybackHours,24+100); assert.equal(r.paysBackWithinHorizon,true);
// non-positive profit never pays back; bad input is rejected, not NaN
assert.equal(T.roi({cost:1000,extraProfitPerHour:-1,horizonDays:5}).paybackHours,null);
assert.equal(T.roi({cost:0,extraProfitPerHour:1}).ok,false);
assert.equal(T.roi({cost:5,extraProfitPerHour:1,horizonDays:0}).ok,false);

// Loan — simple interest, hourly cost of debt, out-earn test.
let l=T.loan({principal:10000,ratePct:1,ratePeriod:'day',termDays:10,fundedProfitPerHour:20});
near(l.totalInterest,1000); near(l.totalRepayment,11000); near(l.hourlyDebtCost,1000/240); near(l.breakEvenProfitPerHour,1000/240);
assert.equal(l.outEarnsDebt,true); near(l.netOverTerm,20*240-1000);
l=T.loan({principal:10000,ratePct:1,ratePeriod:'day',termDays:10,fundedProfitPerHour:1,leadTimeHours:0}); assert.equal(l.outEarnsDebt,false);
near(T.loan({principal:8760,ratePct:10,ratePeriod:'year',termDays:365}).totalInterest,876);
assert.equal(T.loan({principal:1,ratePct:-1,termDays:1}).ok,false);

// Allocation — ranked by profit/h; return on capital reported separately; opportunity cost.
const a=T.allocate([{name:'Big',cost:1e6,profitPerHour:100},{name:'Small',cost:1e4,profitPerHour:60},{name:'Bad',cost:5e3,profitPerHour:-5}],{budget:2e4});
assert.deepEqual(a.rows.map(x=>x.name),['Big','Small','Bad']);
assert.deepEqual(a.rankingByReturnOnCapital,['Small','Big','Bad']);
near(a.rows[0].opportunityCostPerHour,60); near(a.rows[1].opportunityCostPerHour,40);
assert.equal(a.rows[0].affordable,false); assert.equal(a.rows[1].affordable,true);
near(a.rows[1].returnPerDay,60*24/1e4);

// Profit per hour per level — simconomist methodology formulas, checked by hand.
let p=T.profitPerHour({baseRatePerLevel:100,level:2,productionBonusPct:10,abundancePct:100,salePrice:10,sellMode:'exchange',
  inputs:[{qty:2,unitPrice:1},{qty:1,unitPrice:0.5}],transportUnits:1,transportUnitCost:0.25,wagePerHourPerLevel:50,adminOverheadPct:10});
const uph=100*2*1.1; near(p.unitsPerHour,uph);
const labour=(50*2)/uph*1.1, inputs=2.5, transport=0.25, net=10*0.97;
near(p.labourPerUnit,labour); near(p.inputCostPerUnit,inputs); near(p.transportPerUnit,transport); near(p.netRevenuePerUnit,net);
near(p.profitPerUnit,net-inputs-labour-transport); near(p.profitPerHour,(net-inputs-labour-transport)*uph);
near(p.profitPerHourPerLevel,p.profitPerHour/2); near(p.breakEvenPrice,(inputs+labour+transport)/0.97);
// contract: no fee, the same transport units as the exchange (2.5.395); robots toggle scales wages
p=T.profitPerHour({baseRatePerLevel:10,salePrice:10,sellMode:'contract',transportUnits:2,transportUnitCost:1,inputs:[]});
near(p.netRevenuePerUnit,10); near(p.transportPerUnit,2);
const w1=T.profitPerHour({baseRatePerLevel:10,salePrice:10,wagePerHourPerLevel:100,inputs:[]}), w2=T.profitPerHour({baseRatePerLevel:10,salePrice:10,wagePerHourPerLevel:100,robots:true,inputs:[]});
near(w2.hourlyWages,w1.hourlyWages*0.97);
// level cancels out of profit per unit, not per hour
const L1=T.profitPerHour({baseRatePerLevel:10,salePrice:10,wagePerHourPerLevel:5,level:1,inputs:[]}),L5=T.profitPerHour({baseRatePerLevel:10,salePrice:10,wagePerHourPerLevel:5,level:5,inputs:[]});
near(L1.profitPerUnit,L5.profitPerUnit); near(L5.profitPerHour,L1.profitPerHour*5); near(L5.profitPerHourPerLevel,L1.profitPerHourPerLevel);
// missing input price is reported, not silently treated as free
p=T.profitPerHour({baseRatePerLevel:10,salePrice:10,inputs:[{id:9,name:'Ghost',qty:1,unitPrice:null}]}); assert.equal(p.incomplete,true); assert.deepEqual(p.missingInputs,['Ghost']);
assert.equal(T.profitPerHour({baseRatePerLevel:0,salePrice:1}).ok,false);

// rankProducts against the real shipped data files.
const fs=require('node:fs');
const recipes=JSON.parse(fs.readFileSync(path.join(__dirname,'..','recipes.json'),'utf8'));
const rates=JSON.parse(fs.readFileSync(path.join(__dirname,'..','production_rates_normal.json'),'utf8'));
const fb=JSON.parse(fs.readFileSync(path.join(__dirname,'..','vwap-fallback.json'),'utf8')).rows;
const priceMap=new Map(fb.map(x=>[`${x.resourceId}:${x.quality}`,x.value]));
const ranked=T.rankProducts({recipes,rates,priceOf:(id,q)=>priceMap.get(`${id}:${q}`)??null});
assert.ok(ranked.rows.length>40,`ranks many real products (${ranked.rows.length})`);
assert.ok(ranked.rows.every(x=>Number.isFinite(x.profitPerHourPerLevel)),'all finite');
for(let i=1;i<ranked.rows.length;i++){const a=ranked.rows[i-1],b=ranked.rows[i]; if(a.incomplete===b.incomplete)assert.ok(a.profitPerHourPerLevel>=b.profitPerHourPerLevel,'sorted');}
assert.ok(ranked.skipped.every(s=>s.reason),'every skipped product has a reason');

// Series / change windows / movers.
const now=Date.UTC(2026,9,22,12,0,0);
const s=[[now-7*24*H,100],[now-24*H,110],[now-1*H,120],[now,121]];
near(T.changeOver(s,'24h'),(121/110-1)*100); near(T.changeOver(s,'1h'),(121/120-1)*100); near(T.changeOver(s,'7d'),21);
assert.equal(T.changeOver([[now-30*H,100],[now,110]],'1h'),null,'no observation near enough => dash');
assert.equal(T.changeOver([[now,100]],'24h'),null);
assert.notEqual(T.changeOver([[now-22*H,100],[now,110]],'24h'),null,'2h off the 24h mark is within tolerance');
assert.equal(T.changeOver([[now-20*H,100],[now,110]],'24h'),null,'4h off the 24h mark is outside tolerance => dash');
assert.equal(T.profitPerHour({baseRatePerLevel:10,salePrice:null}).ok,false,'null sale price is not treated as 0');
assert.equal(T.roi({cost:100,extraProfitPerHour:null}).ok,false);
const mv=T.moversTable(new Map([[1,[[now-24*H,10],[now,12]]],[2,[[now-24*H,10],[now,9]]],[3,[[now-24*H,10],[now,10.1]]],[4,[[now,5]]],[5,[[now-100*H,5],[now,6]]]]),new Map([['1',{name:'Alpha'}],['2',{name:'Beta'}]]));
assert.deepEqual(mv.ranked.map(x=>x.id),[1,2,3],'ranked by |24h| change'); assert.equal(mv.ranked[0].name,'Alpha');
assert.deepEqual(mv.unranked.map(x=>x.id),[5],'series without a 24h reference is listed separately'); assert.equal(mv.ranked.some(x=>x.id===4),false);
// stats & volatility
const st=T.rangeStats([[1,500],[2,795],[3,710]]); near(st.low,500); near(st.high,795); near(st.average,(500+795+710)/3); near(st.positionPct,(710-500)/(795-500)*100);
assert.equal(T.volatility([[now-2*H,1],[now-H,1],[now,1]]),0);
assert.ok(T.volatility([[now-3*H,100],[now-2*H,110],[now-H,99],[now,120]])>0);
assert.equal(T.sliceRange(s,'1D').length,3); assert.equal(T.sliceRange(s,'MAX').length,4);
assert.match(T.seriesToCsv([[now,5]]),/^timestamp,iso,price\n\d+,2026-10-22T12:00:00.000Z,5\n$/);

// Merging the Manager's old daily history with the live log never interleaves the two sources.
const hist={'7:0':[{date:'2026-10-20',vwap:50},{date:'2026-10-21',vwap:51}],'7:3':[{date:'2026-10-21',vwap:99}]};
let m=T.seriesForResource(7,[],hist); assert.deepEqual(m.map(x=>x[1]),[50,51],'uses lowest stored quality');
m=T.seriesForResource(7,[[Date.UTC(2026,9,21,19),52],[Date.UTC(2026,9,22),53]],hist); assert.deepEqual(m.map(x=>x[1]),[50,51,52,53]);
m=T.seriesForResource(7,[[Date.UTC(2026,9,20,13),52]],hist); assert.deepEqual(m.map(x=>x[1]),[52],'daily points on/after the first live point are dropped');

// Observation log: lowest quality per resource, min-gap, caps.
const rows=[{resourceId:1,quality:2,value:5},{resourceId:1,quality:0,value:4},{resourceId:2,quality:1,value:9},{resourceId:3,quality:0,value:0},{resourceId:'x',quality:0,value:1}];
let log=T.appendObservations(null,rows,now); assert.deepEqual(log.series[1],[[now,4]]); assert.deepEqual(log.series[2],[[now,9]]); assert.equal(log.series[3],undefined); assert.equal(log.added,2);
let log2=T.appendObservations(log,rows,now+5*60000); assert.equal(log2.series[1].length,1,'min gap respected'); assert.equal(log2.added,0);
log2=T.appendObservations(log,[{resourceId:1,quality:0,value:6}],now+11*60000); assert.deepEqual(log2.series[1].map(x=>x[1]),[4,6]);
assert.equal(log.series[1].length,1,'input log is not mutated');
let big=null; for(let i=0;i<30;i++)big=T.appendObservations(big,[{resourceId:1,quality:0,value:1+i}],now+i*20*60000,{maxPoints:10}); assert.equal(big.series[1].length,10); assert.equal(big.series[1][9][1],30);
console.log('tools-core: all assertions passed');

// buildingProfit — uses the planner's measured rate and real qualities. Numbers from the user's
// Car factory #1 card: Bulldozer Q3 at level 4, 26.452 units/h, inputs per unit 4 Steel, 1 Car body, 2 Combustion engine.
{
  const base={unitsPerHour:26.452,level:4,salePrice:2190.94,transportUnits:5,transportUnitCost:0.25,
    inputs:[{name:'Steel',qtyPerUnit:4,unitPrice:11.76},{name:'Car body',qtyPerUnit:1,unitPrice:711.843},{name:'Combustion engine',qtyPerUnit:2,unitPrice:634.16}]};
  const inputCost=4*11.76+711.843+2*634.16;
  const ex=T.buildingProfit({...base,sellMode:'exchange',exchangeFeePct:4});
  near(ex.unitsPerHour,26.452); near(ex.inputCostPerUnit,inputCost); near(ex.transportPerUnit,1.25);
  near(ex.netRevenuePerUnit,2190.94*0.96); near(ex.profitPerHour,(2190.94*0.96-inputCost-1.25)*26.452,1e-6); near(ex.profitPerHourPerLevel,ex.profitPerHour/4);
  near(ex.feePerUnit,2190.94*0.04);
  // Contract: no exchange fee, the same 5 transport units as the exchange (2.5.395), sold at a discount from market.
  const ct=T.buildingProfit({...base,sellMode:'contract',exchangeFeePct:4,contractDiscountPct:3});
  near(ct.netRevenuePerUnit,2190.94*0.97); near(ct.transportPerUnit,1.25); near(ct.breakEvenPrice,ct.totalCostPerUnit/0.97);
  // Contract with the same 4% discount as the exchange fee earns the same per unit.
  const ct4=T.buildingProfit({...base,sellMode:'contract',contractDiscountPct:4});
  near(ct4.profitPerUnit-ex.profitPerUnit,0,1e-9);
  assert.equal(T.buildingProfit({level:4}).ok,false);
}
console.log('tools-core: buildingProfit assertions passed');
// Reconciliation with the game's own Profit Calculator (user's captured R2 data, Car factory #1, Bulldozer Q3, level 4):
// game: sale $2,260, warehouse inputs $9.45 / $655.27 / $483.75, labour $91.06/unit -> $508.36/unit, $3,361.76/h/level.
{
  const g=T.buildingProfit({unitsPerHour:26.452,level:4,salePrice:2260,labourPerUnit:91.06,exchangeFeePct:0,transportUnits:0,
    inputs:[{qtyPerUnit:4,unitPrice:9.45},{qtyPerUnit:1,unitPrice:655.27},{qtyPerUnit:2,unitPrice:483.75}]});
  // the game rounds each displayed input to the cent, so allow 2 cents
  near(g.inputCostPerUnit+g.labourPerUnit,1751.64,0.02); near(g.profitPerUnit,508.36,0.02); near(g.profitPerHourPerLevel,3361.76,0.5);
  console.log('tools-core: matches the game Profit Calculator');
}
