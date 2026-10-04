// Mandai 门票比价器：价格数据在 prices.json，每次打开页面时拉取后计算。
let DATA, PARKS, PK, ALL, CARDS, BUNDLES, HOLIDAYS;
const AGES = {adult:'成人', child:'儿童 3–12', student:'学生（本地）', senior:'长者 60+', infant:'3 岁以下'};
const WEEK = ['周日','周一','周二','周三','周四','周五','周六'];

const state = {
  people:[{res:'local',age:'adult'},{res:'tourist',age:'adult'}],
  pref:{rwa:'must',zoo:'maybe',ns:'maybe',bp:'maybe',rw:'maybe',exp:'no'},
  dates:['2026-10-12','2026-10-13'],
  cards:new Set(['pdebit']), useOta:true, ota:{}
};

const money = v => 'S$' + (Math.round(v*100)/100).toFixed(2).replace(/\.00$/,'');
const $ = s => document.querySelector(s);

/* ---------- dates ---------- */
function addDays(iso, n){ const d = new Date(iso+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function inRange(iso, from, to){ return (!from || iso>=from) && (!to || iso<=to); }
function dayInfo(iso){
  const dow = new Date(iso+'T00:00:00Z').getUTCDay();
  const ph = HOLIDAYS[iso], eve = !ph && HOLIDAYS[addDays(iso,1)];
  const peak = dow===0 || dow===6 || !!ph;
  const okCard = c => {
    if (!inRange(iso, c.from, c.to)) return false;
    if (c.days==='all') return true;
    if (ph || eve) return false;
    return c.days==='noPH' || (dow>=1 && dow<=4);
  };
  return {iso, dow, ph, eve, peak, okCards:new Set(CARDS.filter(okCard).map(c=>c.id)),
          okBundles:new Set(Object.entries(BUNDLES).filter(([,b])=>inRange(iso,b.from,b.to)).map(([k])=>k))};
}
function dayLabel(d){ const [, m, dd] = d.iso.split('-'); return `${+m}月${+dd}日 ${WEEK[d.dow]}`; }
function dayKind(d){ return d.ph ? `公共假期（${d.ph}）` : d.eve ? `${d.eve}前夕` : d.peak ? '周末价' : '平日价'; }

/* ---------- pricing ---------- */
function ticketType(p){ return p.age==='child' ? 'c' : 'a'; }
function singleOptions(p, parkId, ctx, day){
  const park = PK[parkId], t = ticketType(p), out = [];
  if (p.res==='local'){
    const k = {adult:'a',child:'c',student:'s',senior:'sr'}[p.age];
    out.push({ch:'官网 · 本地居民价', price:(day.peak ? park.peak : park.reg)[k], kind:'official'});
  } else {
    out.push({ch:'官网 · 游客价', price:park.std[t], kind:'official'});
  }
  for (const c of CARDS){
    if (!ctx.cards.has(c.id) || !c.parks.includes(parkId) || !day.okCards.has(c.id)) continue;
    const label = c.kind==='sia' ? `Pelago · 新航专享 ${Math.round(c.pct*100)}% off` : `合作门户 · ${c.name} ${Math.round(c.pct*100)}% off`;
    out.push({ch:label, price:+(park.std[t]*(1-c.pct)).toFixed(2), kind:c.kind, card:c.id});
  }
  if (ctx.useOta){
    const o = ctx.ota[parkId];
    out.push({ch:'OTA（Klook / Trip.com 等）', price:o[t], kind:'ota', est:o.est});
  }
  return out.sort((x,y)=>x.price-y.price);
}
function bundlePrice(bid, p, ctx, parks, day){
  const b = BUNDLES[bid];
  if (b.who==='local' && p.res!=='local') return null;
  if (!day.okBundles.has(bid)) return null;
  if (b.requiresCard && !(ctx.cards.has(b.requiresCard) && day.okCards.has(b.requiresCard))) return null;
  if (b.kind==='ota'){ if (!ctx.useOta) return null; const o = ctx.ota[bid]; return {price:o[ticketType(p)], est:o.est}; }
  if (b.combos){
    const c = b.combos.find(x => x.parks.length===parks.length && x.parks.every(id=>parks.includes(id)));
    if (!c) return null;
    return {price:(b.kidAges.includes(p.age) ? c.kid : c.adult)[day.peak ? 'peak' : 'reg']};
  }
  return {price:b[ticketType(p)]};
}

// 一个人在给定分天方案下的最低买法：单票 + 各种套票做精确覆盖（位掩码 DP）
function coverPerson(p, schedule, ctx, banned){
  const S = schedule.flatMap(d=>d.parks), n = S.length, full = (1<<n)-1;
  const dayIdx = id => schedule.findIndex(d=>d.parks.includes(id));
  const products = [];
  S.forEach((id,i)=>{
    const o = singleOptions(p, id, ctx, schedule[dayIdx(id)].day).find(o => !(banned && o.card==='ntuc'));
    products.push({mask:1<<i, cost:o.price, item:{type:'single', park:id, ...o}});
  });
  for (const [bid, b] of Object.entries(BUNDLES)){
    for (let m=1; m<=full; m++){
      const parks = S.filter((_,i)=>m>>i&1);
      if (parks.length<2 || parks.length>b.max) continue;
      if (!parks.every(id=>b.parks.includes(id))) continue;
      const days = new Set(parks.map(dayIdx));
      if (b.oneDay && days.size>1) continue;
      const pr = bundlePrice(bid, p, ctx, parks, schedule[Math.min(...days)].day);
      if (!pr) continue;
      products.push({mask:m, cost:pr.price, item:{type:'pass', pass:bid, parks, price:pr.price, kind:b.kind, est:pr.est}});
    }
  }
  const best = new Array(full+1).fill(null); best[0] = {cost:0, items:[]};
  for (let m=1; m<=full; m++){
    const low = m & -m;
    for (const pr of products){
      if (!(pr.mask & low) || (pr.mask & ~m)) continue;
      const rest = best[m & ~pr.mask];
      if (rest && (!best[m] || rest.cost+pr.cost < best[m].cost - 1e-9)) best[m] = {cost:rest.cost+pr.cost, items:[...rest.items, pr.item]};
    }
  }
  const out = schedule.map(()=>[]);
  for (const it of best[full].items) out[dayIdx(it.type==='pass' ? it.parks[0] : it.park)].push(it);
  return {cost:best[full].cost, days:out};
}

// 把园区分到若干天：每天 ≤2 个白天园 + 夜间动物园
function partitions(parks, maxDays){
  const res = [];
  (function rec(i, days){
    if (i===parks.length){ res.push(days.map(d=>[...d])); return; }
    const id = parks[i];
    for (const d of days){
      if (PK[id].night ? d.some(x=>PK[x].night) : d.filter(x=>!PK[x].night).length>=2) continue;
      d.push(id); rec(i+1, days); d.pop();
    }
    if (days.length < maxDays){ days.push([id]); rec(i+1, days); days.pop(); }
  })(0, []);
  return res;
}
// 把每组园区放到具体日期上。价格规则完全相同的日期视为同一类，避免重复枚举
function schedules(parks, ctx){
  const days = ctx.days;
  const sig = d => [d.peak, ...[...d.okCards].filter(id=>ctx.cards.has(id)), ...d.okBundles].join('|');
  const classes = [];
  for (const d of days){ const k = sig(d); let c = classes.find(x=>x.k===k); if (!c) classes.push(c = {k, days:[]}); c.days.push(d); }
  const out = [];
  for (const blocks of partitions(parks, days.length)){
    (function rec(i, used, assign){
      if (i===blocks.length){
        const taken = classes.map(()=>0);
        const sch = blocks.map((b,j)=>({parks:b, day:classes[assign[j]].days[taken[assign[j]]++]}));
        out.push(sch.sort((x,y)=>x.day.iso<y.day.iso?-1:1)); return;
      }
      for (let c=0; c<classes.length; c++){
        if (used[c] >= classes[c].days.length) continue;
        used[c]++; assign.push(c); rec(i+1, used, assign); assign.pop(); used[c]--;
      }
    })(0, classes.map(()=>0), []);
  }
  return out;
}

function groupCost(parks, ctx){
  const payers = ctx.people.filter(p=>p.age!=='infant');
  let best = null;
  for (const sch of schedules(parks, ctx)){
    let per = payers.map(p => coverPerson(p, sch, ctx, false));
    // NTUC 每人限购 4 张：超出则让节省最少的人改用次优渠道
    const ntucCount = per.flatMap(r=>r.days.flat()).filter(it=>it.card==='ntuc').length;
    if (ntucCount > 4){
      const alt = payers.map(p => coverPerson(p, sch, ctx, true));
      const order = payers.map((_,i)=>i).sort((a,b)=>(alt[a].cost-per[a].cost)-(alt[b].cost-per[b].cost));
      let used = ntucCount;
      for (const i of order){
        if (used<=4) break;
        const n = per[i].days.flat().filter(it=>it.card==='ntuc').length;
        if (n){ per[i] = alt[i]; used -= n; }
      }
    }
    const total = per.reduce((s,r)=>s+r.cost,0);
    if (!best || total < best.total - 1e-9 || (Math.abs(total-best.total)<1e-9 && sch.length < best.schedule.length))
      best = {total, schedule:sch, per, payers};
  }
  return best;
}
function officialSingles(plan, ctx){
  const c = {...ctx, cards:new Set(), useOta:false};
  return plan.payers.reduce((s,p)=> s + plan.schedule.reduce((t,d)=> t + d.parks.reduce((u,id)=> u + singleOptions(p,id,c,d.day)[0].price,0),0),0);
}
function subsets(arr){ const out=[[]]; for (const x of arr) for (const s of [...out]) out.push([...s,x]); return out; }
function makeCtx(){
  const iso = [...new Set(state.dates.filter(Boolean))].sort();
  return {...state, days:iso.map(dayInfo)};
}

/* ---------- controls ---------- */
function renderPeople(){
  $('#people').innerHTML = state.people.map((p,i)=>`
    <div class="person">
      <select id="res${i}" data-i="${i}" data-k="res" aria-label="身份">
        <option value="local" ${p.res==='local'?'selected':''}>本地居民</option>
        <option value="tourist" ${p.res==='tourist'?'selected':''}>外国游客</option>
      </select>
      <select id="age${i}" data-i="${i}" data-k="age" aria-label="年龄类别">
        ${Object.entries(AGES).filter(([k])=>!(k==='student'&&p.res==='tourist')).map(([k,v])=>`<option value="${k}" ${p.age===k?'selected':''}>${v}</option>`).join('')}
      </select>
      <button class="icon-btn" type="button" data-del="${i}" aria-label="删除" ${state.people.length<2?'disabled':''}>✕</button>
    </div>`).join('');
}
function renderDates(){
  $('#dates').innerHTML = state.dates.map((iso,i)=>{
    let tag = '<span class="dtag">请选择日期</span>';
    if (iso){
      const d = dayInfo(iso);
      const lost = [...state.cards].filter(id=>!d.okCards.has(id)).map(id=>CARDS.find(c=>c.id===id).name);
      tag = `<span class="dtag"><b>${WEEK[d.dow]}</b> · ${dayKind(d)}${lost.length?`<span class="warn">当天不能用：${lost.join('、')}</span>`:''}</span>`;
    }
    return `<div class="date-row"><input type="date" id="date${i}" data-date="${i}" value="${iso}" min="2026-01-01" max="2027-12-31" aria-label="第 ${i+1} 天日期">${tag}
      <button class="icon-btn" type="button" data-deldate="${i}" aria-label="删除这一天" ${state.dates.length<2?'disabled':''}>✕</button></div>`;
  }).join('');
  $('#addD').disabled = state.dates.length>=5;
}
function renderParks(){
  $('#parks').innerHTML = PARKS.map(p=>`
    <div class="park">
      <div class="nm"><b>${p.name}</b><small>${p.en}${p.note?' · '+p.note:''}</small></div>
      <div class="seg" role="group" aria-label="${p.name}">
        ${[['must','必去'],['maybe','随意'],['no','不去']].map(([v,l])=>`<button type="button" class="${v}" data-park="${p.id}" data-v="${v}" aria-pressed="${state.pref[p.id]===v}">${l}</button>`).join('')}
      </div>
    </div>`).join('');
}
function renderCards(){
  $('#cards').innerHTML = CARDS.map(c=>`<label><input type="checkbox" id="card-${c.id}" data-card="${c.id}" ${state.cards.has(c.id)?'checked':''}><span>${c.name} <small>${Math.round(c.pct*100)}%</small></span></label>`).join('');
}
function renderOta(){
  $('#ota').innerHTML = '<span class="lbl">园区</span><span class="lbl">成人</span><span class="lbl">儿童</span>' +
    [...PARKS.map(p=>[p.id,p.name]), ...['otaFlex2','klookWild'].map(k=>[k,BUNDLES[k].name])].map(([k,name])=>`<span>${name}</span>
      <input type="number" step="0.1" min="0" id="ota-${k}-a" data-ota="${k}" data-t="a" value="${state.ota[k].a}" aria-label="${name} 成人价">
      <input type="number" step="0.1" min="0" id="ota-${k}-c" data-ota="${k}" data-t="c" value="${state.ota[k].c}" aria-label="${name} 儿童价">`).join('');
}

/* ---------- results ---------- */
const STORE = 'https://buy.mandai.com/web-storefront/en';
function buyInfo(it, p, day){
  if (it.type==='pass' && it.pass==='l2') return {key:'l2', name:'Mandai 官网 · 本地居民专享 2 园套票', url:'https://www.mandai.com/en/discover-mandai/promotions/2-attraction-pass.html', needs:[
    '仅限 WildPass 本地居民：先用 Singpass 注册 / 登录 WildPass',
    '只有 5 种组合：动物园+飞禽、动物园+河川、动物园+Exploria、雨林+动物园、雨林+Exploria',
    '1 日有效，购买时选定日期；13–21 岁本地学生按儿童价，入园出示学生证',
    '有效期至 2027-03-31，入园可能查 NRIC / PR 卡']};
  if (it.type==='pass' && it.pass==='otaFlex2') return {key:'otaFlex2', name:'OTA · Klook / KKday 任选 2 园套票', url:'https://www.klook.com/en-SG/activity/30305-singapore-zoo-multi-parks-bundle/', alt:['KKday','https://www.kkday.com/en-sg/product/39249-mandai-wildlife-bundle-singapore'], needs:[
    '先在 App 里看实价：通常约 US$68–69，和官网 S$88 差不多，便宜才买',
    '确认套餐里能选雨林（Rainforest Wild Adventure）',
    '1 日有效，两个园必须同一天去；看清是否可退改']};
  if (it.type==='pass' && it.pass==='klookWild') return {key:'klookWild', name:'OTA · Klook Singapore Wildlife Pass', url:'https://www.klook.com/en-SG/activity/70278-singapore-wildlife-pass/', needs:[
    '只能从动物园 / 夜间动物园 / 河川 / 飞禽里选，不含雨林',
    '本页价格为估算（成人 S$93.99 来自搜索结果，儿童价未查到），下单前核对并改左侧价格',
    '确认选几个园、有效天数和是否需要预约']};
  if (it.kind==='sia') return {key:'sia', name:'Pelago · 新航 KrisFlyer 专享', url:'https://www.pelago.com/en-SG/static-pages/sia-mandai-2026/', needs:[
    '用 KrisFlyer 账号登录 Pelago（需是 KrisFlyer 会员）',
    '账号里要有飞新加坡的新航机票，选 “Singapore Airlines Exclusive” 选项',
    '单园 75 折只含雨林、动物园、飞禽、河川；5 日套票成人减 S$10、儿童减 S$5',
    '能否一次替同行的人一起买未写明，下单时确认；有效期至 2027-03-31']};
  if (it.type==='pass') return {key:'pass', name:'Mandai 官网 · Destination Pass', url:'https://www.mandai.com/en/tickets-and-passes/multi-attractions.html', needs:[
    '在官网选对应套票，按人数选 Adult / Child（本地人和游客同价）',
    '1 日套票：套票里的园必须同一天去；5 日套票：从所选日期起连续 5 天有效',
    '选择入园日期；夜间动物园需选入园时段',
    '任意信用卡付款，电子票发到邮箱，入园扫码']};
  if (it.kind==='partner'){
    const c = CARDS.find(x=>x.id===it.card);
    const needs = [
      c.id==='ntuc' ? '登录：NRIC 后 4 位 + 出生日期 + 注册手机号' : `登录：在门户输入促销码 <b>${c.code}</b> 作为 Login ID`,
      `付款：必须用 <b>${c.name}</b> 刷卡，可在同一笔订单里替朋友一起买（按 Adult / Child 选）`,
      c.days==='monthu' ? '可用日：仅周一至周四，不含公共假期及前夕' : '可用日：除公共假期当天及前夕外每天可用',
      `有效期至 ${c.to}；每月名额有限，售完即止；不可与其他优惠叠加`,
      '夜间动物园、Exploria 需预约入园日期和时段'];
    if (c.cap) needs.push(`每人限购 ${c.cap} 张`);
    if (c.guess) needs.push('可用日官网未写明，下单时以门户显示为准');
    return {key:'card-'+c.id, name:`合作门户 · ${c.name}`, url:c.url, tc:c.tc, needs};
  }
  if (it.kind==='ota') return {key:'ota', name:'OTA · Trip.com / Klook', url:'https://www.trip.com/travel-guide/attraction/singapore/rainforest-wild-adventure-149671899/', alt:['Klook','https://www.klook.com/en-SG/activity/142887-rainforest-wild-asia-ticket-in-singapore/'], needs:[
    '先在 App 里核对实际价格，比本页估算价高就改回官网',
    '看清是否可退改（部分不可取消）和是否含电车',
    '选日期、填游客护照姓名，电子票入园扫码']};
  if (p && p.res==='local') return {key:'official-local', name:'Mandai 官网 · 本地居民票', url:STORE, needs:[
    '用 Singpass 注册 / 登录 WildPass（免费，15 岁以上）',
    '选 Local Resident 票种；平日和周末/公共假期价格不同，按入园日期自动计价',
    '入园时带 NRIC / PR 卡 / 工作准证备查',
    '学生票需学生证，长者票需 60 岁以上证件']};
  return {key:'official-std', name:'Mandai 官网 · 游客票', url:STORE, needs:[
    '选 Non-Resident（Standard）票种，任意信用卡付款',
    '夜间动物园需选入园时段',
    '电子票发到邮箱，入园扫码']};
}
function itemName(it){ return it.type==='pass' ? BUNDLES[it.pass].name : it.ch; }
function itemRow(it, who, p){
  const chip = it.type==='pass' ? 'chip pass' : it.kind==='ota' ? 'chip est' : 'chip';
  const what = it.type==='pass' ? it.parks.map(x=>PK[x].name).join(' + ') : PK[it.park].name;
  return `<tr><td>${who}</td><td>${what}</td><td><span class="${chip}">${itemName(it)}${it.est?' ≈估':''}</span><br><a class="buy" href="${buyInfo(it,p).url}" target="_blank" rel="noopener">去购买 ↗</a></td><td class="num">${money(it.price)}</td></tr>`;
}
function whoLabel(p, i){ return `${p.res==='local'?'本地':'游客'}·${AGES[p.age].split(' ')[0]} #${i+1}`; }

function planBlock(plan){
  return plan.schedule.map((d,di)=>{
    const rows = plan.per.map((r,pi)=> r.days[di].map(it=>itemRow(it, whoLabel(plan.payers[pi], pi), plan.payers[pi])).join('')).join('');
    return `<div class="day"><h3>${dayLabel(d.day)}（${dayKind(d.day)}）：${d.parks.map(x=>PK[x].name).join(' → ').replace(/ → (夜间动物园)/,' → 晚上 $1')}</h3>
      ${rows ? `<div class="tbl"><table><thead><tr><th>谁</th><th>园区</th><th>在哪买</th><th class="num">价格</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="hint">已含在前面的多日套票内。</p>'}</div>`;
  }).join('');
}
function checklist(plan){
  const groups = new Map();
  plan.per.forEach((r,pi)=>{
    const p = plan.payers[pi];
    r.days.forEach((items,di)=>items.forEach(it=>{
      const b = buyInfo(it,p);
      if (!groups.has(b.key)) groups.set(b.key, {...b, lines:[], total:0});
      const g = groups.get(b.key);
      const what = it.type==='pass' ? `${BUNDLES[it.pass].name}（${it.parks.map(x=>PK[x].name).join('、')}）` : PK[it.park].name;
      g.lines.push(`${dayLabel(plan.schedule[di].day)} · ${whoLabel(p,pi)} · ${what} · ${money(it.price)}`);
      g.total += it.price;
    }));
  });
  return `<div class="panel"><h2>下单清单</h2><div class="orders">${[...groups.values()].map((g,i)=>`
    <div class="order">
      <div class="order-head"><div><span class="lbl">第 ${i+1} 笔订单</span><h3>${g.name}</h3></div>
        <a class="go" href="${g.url}" target="_blank" rel="noopener">打开购买页 ↗</a></div>
      <ul class="lines">${g.lines.map(l=>`<li>${l}</li>`).join('')}</ul>
      <div class="sub">小计 <b>${money(g.total)}</b></div>
      <span class="lbl">需要准备</span>
      <ul class="needs">${g.needs.map(n=>`<li><label><input type="checkbox"> <span>${n}</span></label></li>`).join('')}</ul>
      ${g.tc?`<a class="buy" href="${g.tc}" target="_blank" rel="noopener">官方条款 PDF ↗</a>`:''}${g.alt?` <a class="buy" href="${g.alt[1]}" target="_blank" rel="noopener">${g.alt[0]} ↗</a>`:''}
    </div>`).join('')}</div></div>`;
}
function channelsTable(){
  return `<div class="panel src"><h2>订票渠道一览</h2>
  <div class="tbl"><table><thead><tr><th>渠道</th><th>谁能用</th><th>价格 / 条件</th></tr></thead><tbody>
  ${DATA.channels.map(c=>`<tr><td>${c.links.map(([l,u])=>`<a href="${u}" target="_blank" rel="noopener">${l}</a>`).join(' / ')}</td><td>${c.who}</td><td>${c.terms}</td></tr>`).join('')}
  </tbody></table></div></div>`;
}

function render(){
  const ctx = makeCtx();
  const must = ALL.filter(id=>state.pref[id]==='must');
  const maybe = ALL.filter(id=>state.pref[id]==='maybe');
  const el = $('#results');
  if (!ctx.days.length){ el.innerHTML = '<div class="panel">请至少选一个游玩日期。</div>'; return; }
  if (!must.length && !maybe.length){ el.innerHTML = '<div class="panel">请至少选一个“必去”或“随意”的园区。</div>'; return; }
  if (state.people.every(p=>p.age==='infant')){ el.innerHTML = '<div class="panel">3 岁以下免费，需要至少一名付费成人同行。</div>'; return; }

  const combos = subsets(maybe).map(s=>[...must,...s]).filter(s=>s.length)
    .map(parks=>({parks, plan:groupCost(parks, ctx)})).filter(x=>x.plan);
  if (!combos.length){ el.innerHTML = '<div class="panel warn">天数不够：每天最多 2 个白天园 + 夜间动物园，请再加一天。</div>' + channelsTable(); return; }
  combos.sort((a,b)=>a.parks.length-b.parks.length || a.plan.total-b.plan.total);

  const head = combos[0];
  const offTotal = officialSingles(head.plan, ctx);
  const usesPartner = head.plan.per.some(r=>r.days.flat().some(it=>it.kind==='partner'));
  const usesEst = head.plan.per.some(r=>r.days.flat().some(it=>it.est));

  const whatIf = CARDS.filter(c=>!state.cards.has(c.id)).map(c=>{
    const plan = groupCost(head.parks, {...ctx, cards:new Set([...state.cards, c.id])});
    return {c, save: head.plan.total - plan.total};
  }).filter(x=>x.save>0.009).sort((a,b)=>b.save-a.save).slice(0,4);

  const fallback = usesPartner ? groupCost(head.parks, {...ctx, cards:new Set([...state.cards].filter(id=>CARDS.find(c=>c.id===id).kind!=='partner'))}) : null;

  const rows = combos.map(x=>({x, avg:x.plan.total/x.parks.length/x.plan.payers.length, extra:x.plan.total-head.plan.total}));
  const minAvg = Math.min(...rows.map(r=>r.avg));
  const span = ctx.days.length>1 ? `${dayLabel(ctx.days[0])} – ${dayLabel(ctx.days.at(-1))}` : dayLabel(ctx.days[0]);

  el.innerHTML = `
  <div class="best">
    <div class="kicker">最低总价 · ${head.parks.map(x=>PK[x].name).join(' + ')} · ${state.people.length} 人 · ${span}</div>
    <div class="total">${money(head.plan.total)} <small>共 ${head.plan.payers.length} 张付费</small></div>
    <div class="cmp">同样日期全部在官网单买要 ${money(offTotal)}，${offTotal-head.plan.total>0.009 ? `省下 <b>${money(offTotal-head.plan.total)}</b>` : '已是官网价'}。</div>
    ${planBlock(head.plan)}
    ${usesEst ? '<p class="hint">≈估 = OTA 估算价。下单前在 Klook / Trip.com 里核对；若实价更高，在左侧改价后会自动换回其他渠道。</p>' : ''}
    ${fallback ? `<p class="hint">合作门户每月名额有限。如果当月售罄，退而求其次的方案是 <b>${money(fallback.total)}</b>（${[...new Set(fallback.per.flatMap(r=>r.days.flat()).map(itemName))].join('、')}）。</p>`:''}
  </div>

  ${checklist(head.plan)}

  ${whatIf.length ? `<div class="panel"><h2>换个渠道还能更便宜</h2><ul class="whatif">${whatIf.map(w=>`<li>${w.c.kind==='sia' ? `如果${w.c.holder}，用 <b>${w.c.name}</b>` : `如果你（或同行的本地朋友）有 <b>${w.c.name}</b>`}，同样行程再省 <b>${money(w.save)}</b>。</li>`).join('')}</ul>
    <p class="hint">合作门户买的是游客标准价票打折，无身份限制，持卡人一次付款即可帮朋友买。</p></div>` : ''}

  ${combos.length>1 ? `<div class="panel"><h2>多去几个园要加多少钱</h2>
  <div class="tbl"><table><thead><tr><th>组合</th><th class="num">总价</th><th class="num">比最低多</th><th class="num">每人每园</th></tr></thead><tbody>
  ${rows.map(r=>`<tr><td>${r.x.parks.map(x=>PK[x].name).join(' + ')}${Math.abs(r.avg-minAvg)<0.01?'<span class="tag-best">每园最划算</span>':''}<br><small style="color:var(--muted)">${r.x.plan.schedule.map(d=>dayLabel(d.day).split(' ')[0]).join('、')} · ${[...new Set(r.x.plan.per.flatMap(p=>p.days.flat()).map(it=>it.type==='pass'?BUNDLES[it.pass].name:it.kind==='partner'?'合作折扣':it.kind==='sia'?'新航专享':it.kind==='ota'?'OTA':'官网单票'))].join(' / ')}</small></td>
    <td class="num">${money(r.x.plan.total)}</td><td class="num">${r.extra>0.009?'+'+money(r.extra):'—'}</td><td class="num">${money(r.avg)}</td></tr>`).join('')}
  </tbody></table></div>
  <p class="hint">“随意”的园全部排列组合。点上面“必去”可把某个组合锁定为主方案，看它的分天安排。</p></div>` : ''}

  ${channelsTable()}
  `;
}

/* ---------- events ---------- */
document.addEventListener('change', e=>{
  const t = e.target;
  if (!DATA) return;
  if (t.dataset.k){ const p = state.people[+t.dataset.i]; p[t.dataset.k] = t.value; if (p.res==='tourist' && p.age==='student') p.age='adult'; renderPeople(); }
  else if (t.dataset.card){ t.checked ? state.cards.add(t.dataset.card) : state.cards.delete(t.dataset.card); renderDates(); }
  else if (t.dataset.date){ state.dates[+t.dataset.date] = t.value; renderDates(); }
  else if (t.id==='useOta') state.useOta = t.checked;
  else return;
  render();
});
document.addEventListener('input', e=>{
  const t = e.target;
  if (!DATA || !t.dataset.ota) return;
  const v = parseFloat(t.value); if (!(v>=0)) return;
  state.ota[t.dataset.ota][t.dataset.t] = v; state.ota[t.dataset.ota].est = false; render();
});
document.addEventListener('click', e=>{
  const t = e.target.closest('button'); if (!t || !DATA) return;
  if (t.dataset.park){ state.pref[t.dataset.park] = t.dataset.v; renderParks(); render(); }
  else if (t.dataset.del){ state.people.splice(+t.dataset.del,1); renderPeople(); render(); }
  else if (t.dataset.deldate){ state.dates.splice(+t.dataset.deldate,1); renderDates(); render(); }
  else if (t.id==='addP'){ state.people.push({res:'tourist',age:'adult'}); renderPeople(); render(); }
  else if (t.id==='addD' && state.dates.length<5){ const last = [...state.dates].filter(Boolean).sort().at(-1); state.dates.push(last ? addDays(last,1) : ''); renderDates(); render(); }
});

/* ---------- boot: 每次打开都拉取最新 prices.json ---------- */
function init(data){
  DATA = data;
  PARKS = data.parks; PK = Object.fromEntries(PARKS.map(p=>[p.id,p])); ALL = PARKS.map(p=>p.id);
  const expand = v => v==='all' ? ALL : v;
  CARDS = data.cards.map(c=>({...c, parks:expand(c.parks)}));
  BUNDLES = Object.fromEntries(Object.entries(data.bundles).map(([k,b])=>[k,{...b, parks:expand(b.parks || 'all')}]));
  HOLIDAYS = data.holidays;
  for (const [k,v] of Object.entries(data.otaDefaults)) if (!k.startsWith('_')) state.ota[k] = {...v, est:true};
  $('#stamp').textContent = `价格数据更新于 ${data.updatedAt} · 单位 S$（${data.currency}）· 下单前请在对应渠道复核`;
  renderPeople(); renderDates(); renderParks(); renderCards(); renderOta(); render();
}
if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__NO_BOOT){
  fetch('prices.json', {cache:'no-store'})
    .then(r=>{ if (!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(init)
    .catch(err=>{
      $('#stamp').textContent = '价格数据加载失败';
      $('#results').innerHTML = `<div class="panel warn">读不到 prices.json（${err.message}）。如果是在本地直接双击打开的，请在项目目录运行 <code>python3 -m http.server</code>，再访问 http://localhost:8000 。</div>`;
    });
}
