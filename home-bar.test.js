const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously', url: 'https://example.com/',
  beforeParse(w){ w.TextEncoder=TextEncoder; w.TextDecoder=TextDecoder; w.confirm=()=>true; w.scrollTo=()=>{};
    w.fetch = async (url, opts) => {
      const u = String(url);
      if(u.includes('/scan')) return { ok:true, status:200, json: async () => (w.__scanResult || { bottles: [] }) };
      if(u.includes('/recipe')) return { ok:true, status:200, json: async () => (w.__recipeResult || { error:'no mock' }) };
      if(u.includes('/sync')){
        const tok = String((opts&&opts.headers&&(opts.headers.Authorization||opts.headers.authorization))||'').replace('Bearer ','');
        if(opts && opts.method==='PUT'){
          w.__syncStore = w.__syncStore || {};
          w.__syncStore[tok] = opts.body;
          return { ok:true, status:200, json: async()=>({ok:true}), text: async()=>'{"ok":true}' };
        }
        const v = (w.__syncStore||{})[tok];
        return v ? { ok:true, status:200, json: async()=>JSON.parse(v), text: async()=>v }
                 : { ok:false, status:404, json: async()=>({error:'nf'}), text: async()=>'{"error":"nf"}' };
      }
      if(u.includes('/bartender')) return { ok:true, status:200, json: async () => (w.__bartenderResult || { picks: [] }) };
      if(u.includes('/req')){
        if(opts && opts.method === 'POST'){ w.__reqStore = w.__reqStore || []; w.__reqStore.push(JSON.parse(opts.body)); return { ok:true, status:200, json: async () => ({ ok:true, count:w.__reqStore.length }) }; }
        if(opts && opts.method === 'DELETE'){ w.__reqStore = []; return { ok:true, status:200, json: async () => ({ ok:true }) }; }
        return { ok:true, status:200, json: async () => ({ requests: (w.__reqStore||[]).map((x,i) => ({ d:x.drink, g:x.guest, at:1700000000000+i })) }) };
      }
      if(u.includes('/menu')){
        if(opts && opts.method === 'POST'){
          if(w.__menuPostFail) return { ok:false, status:500, json: async () => ({ error:'kv down' }) };
          return { ok:true, status:200, json: async () => ({ id:'abc123' }) };
        }
        return { ok:true, status:200, json: async () => (w.__sharedPayload || { t:'X', c:[], s:[] }) };
      }
      return { ok:false, status:404, json: async () => ({ error:'not found' }) };
    }; },
});
dom.window.addEventListener('error', e => errors.push(e.message));
const w = dom.window, d = w.document;
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await sleep(150);
  const assert = (c,m)=>{ if(!c){console.error('FAIL:',m); process.exitCode=1;} else console.log('ok  :',m); };
  const reset = () => w.eval('S = fresh(); save(); setTab("shelf");');

  // --- boot ---
  assert(errors.length===0, 'no runtime errors on boot'+(errors.length?' -> '+errors.join(' | '):''));
  assert(w.eval('S.recipes.length')===34, 'seeds 34 classic recipes');
  assert(w.eval('S.bottles.length')===0, 'shelf starts empty (no seed bottles)');
  assert(w.eval('S.staples.includes("lime") && S.staples.includes("coconut cream")'), 'default staples loaded');
  assert(!d.getElementById('empty-shelf').classList.contains('hidden'), 'empty-shelf invite shown on first run');
  assert(!d.getElementById('btn-scan-empty').classList.contains('hidden'), 'scan button offered when SCAN_URL configured');

  // --- graceful degradation: no scan URL -> button hidden ---
  w.eval('CFG.scanUrl=""; renderShelf();');
  assert(d.getElementById('btn-scan-empty').classList.contains('hidden'), 'scan button hidden when scan URL empty');
  w.eval('CFG.scanUrl=SCAN_URL; renderShelf();');

  // --- matcher: tag/subtype semantics (acceptance: tequila/reposado) ---
  w.eval('upsertBottle({name:"Mijenta Reposado", category:"tequila", subtype:"reposado", level:"full"})');
  assert(w.eval('reqStatus({tag:{category:"tequila"}}).ok')===true, 'plain {tequila} tag matches a reposado bottle');
  assert(w.eval('reqStatus({tag:{category:"tequila",subtype:"reposado"}}).ok')===true, '{tequila/reposado} tag matches it too');
  assert(w.eval('reqStatus({tag:{category:"tequila",subtype:"blanco"}}).ok')===false, '{tequila/blanco} does not match a reposado');
  assert(w.eval('reqStatus({tag:{category:"tequila",subtype:"REPOSADO "}}).ok')===true, 'subtype match is case/space-insensitive');
  assert(w.eval('reqStatus({staple:"lime"}).ok')===true, 'staple req matches staples list');
  assert(w.eval('reqStatus({staple:"unicorn tears"}).ok')===false, 'unknown staple does not match');

  // Tommy's Margarita = tequila + lime + agave -> makeable with one bottle
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.id==="r11")).makeable')===true, "Tommy's Margarita makeable with tequila + staples");
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.id==="r10")).missing.length')===1, 'Margarita missing exactly one req (orange liqueur)');
  const ul1 = w.eval('JSON.stringify(unlockGroups())');
  assert(JSON.parse(ul1).some(g=>g.key==='tag:liqueur/orange' && g.recipes.includes('Margarita')), 'unlocks suggests orange liqueur for Margarita');

  // --- bottleId req ---
  const mjId = w.eval('S.bottles[0].id');
  assert(w.eval('reqStatus({bottleId:"'+mjId+'"}).ok')===true, 'bottleId req matches the stocked bottle');
  assert(w.eval('reqStatus({bottleId:"nope"}).ok')===false, 'bottleId req fails for unknown id');

  // --- unlock grouping (acceptance: sweet vermouth -> Manhattan, Negroni, Boulevardier) ---
  w.eval('upsertBottle({name:"Eagle Rare", category:"whiskey", subtype:"bourbon", level:"full"})');
  w.eval('upsertBottle({name:"Rittenhouse Rye", category:"whiskey", subtype:"rye", level:"full"})');
  w.eval('upsertBottle({name:"Sipsmith", category:"gin", subtype:"london dry", level:"full"})');
  w.eval('upsertBottle({name:"Campari", category:"amaro", subtype:"campari", level:"full"})');
  w.eval('upsertBottle({name:"Angostura", category:"bitters", subtype:"aromatic", level:"full"})');
  const groups = JSON.parse(w.eval('JSON.stringify(unlockGroups())'));
  const sv = groups.find(g=>g.key==='tag:vermouth/sweet');
  assert(!!sv && sv.recipes.length===3 && ['Manhattan','Negroni','Boulevardier'].every(n=>sv.recipes.includes(n)),
    'sweet vermouth unlock groups Manhattan+Negroni+Boulevardier (3)');
  assert(groups[0].key==='tag:vermouth/sweet', 'unlock groups sorted by count desc (sweet vermouth first)');
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.name==="Old Fashioned")).makeable')===true, 'Old Fashioned makeable with bourbon+bitters');
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.name==="Gimlet")).makeable')===true, 'Gimlet makeable with gin+staples');

  // --- only alcohol gates: staples/mixers/household never block or flag ---
  w.eval('S.staples = S.staples.filter(s=>s!=="lime"); renderAll();');
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.name==="Gimlet")).makeable')===true, 'a household staple never blocks a recipe');
  w.eval('S.staples.push("lime"); save(); renderAll();');
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.name==="Ranch Water")).makeable')===true, 'a missing mixer (soda water) never blocks a recipe');
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.name==="Margarita")).makeable')===false, 'a missing alcohol bottle (orange liqueur) still blocks');
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.name==="Margarita")).missing.every(m=>m.status.kind!=="staple")'), 'missing list holds gating reqs only');
  assert(!JSON.parse(w.eval('JSON.stringify(unlockGroups())')).some(g=>g.key.startsWith('staple:')||g.key.startsWith('tag:mixer')), 'unlocks only ever suggest alcohol bottles');

  // spice & milk categories: labelled cleanly, never gate
  assert(w.eval('CATEGORIES.includes("spice") && CATEGORIES.includes("milk")'), 'spice and milk are first-class categories');
  assert(w.eval('tagLabel({category:"spice",subtype:"cinnamon"})')==='cinnamon', 'a spice ingredient reads as just the spice');
  assert(w.eval('tagLabel({category:"milk",subtype:"condensed milk"})')==='condensed milk', 'a milk ingredient reads cleanly');
  assert(w.eval('reqGates({tag:{category:"spice",subtype:"cinnamon"}})')===false && w.eval('reqGates({tag:{category:"milk"}})')===false, 'spice and milk never gate a recipe');

  // --- low-warning state ---
  const ginId = w.eval('S.bottles.find(b=>b.name==="Sipsmith").id');
  w.eval('cycleLevel("'+ginId+'")'); // full -> low
  assert(w.eval('S.bottles.find(b=>b.id==="'+ginId+'").level')==='low', 'cycleLevel steps full -> low');
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.name==="Gimlet")).makeable')===true
      && w.eval('recipeStatus(S.recipes.find(r=>r.name==="Gimlet")).low')===true, 'Gimlet makeable-but-low when only gin is low');

  // --- acceptance: cycle to "out" -> recipe leaves Makeable instantly ---
  w.eval('S.recipes.find(r=>r.name==="Gimlet").rating=5; save();');
  w.eval('setTab("tonight")');
  assert(d.querySelector('#makeable-list .tonight-item .rname').textContent.includes('Gimlet'), 'Tonight sorts by rating (Gimlet 5★ first)');
  assert(d.querySelector('#makeable-list .lowtag')!==null, 'low warning marked in Tonight');
  w.eval('cycleLevel("'+ginId+'")'); // low -> out
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.name==="Gimlet")).makeable')===false, 'gin out -> Gimlet no longer makeable');
  assert(![...d.querySelectorAll('#makeable-list .rname')].some(el=>el.textContent.includes('Gimlet')), 'Gimlet left the Makeable list instantly');
  assert([...d.querySelectorAll('#shopping-list .shopline')].some(el=>/Sipsmith/.test(el.textContent)&&/out/.test(el.textContent)), 'out bottle lands on the shopping list');
  w.eval('cycleLevel("'+ginId+'")'); // out -> full

  // --- shelf UI: tap row cycles, edit sheet saves ---
  w.eval('setTab("shelf")');
  const row = [...d.querySelectorAll('.bottle')].find(el=>el.textContent.includes('Campari'));
  row.click(); await sleep(30);
  assert(w.eval('S.bottles.find(b=>b.name==="Campari").level')==='low', 'tapping a bottle row cycles its level');
  const row2 = [...d.querySelectorAll('.bottle')].find(el=>el.textContent.includes('Campari'));
  row2.querySelector('.editb').click(); await sleep(30);
  assert(d.querySelector('#modalwrap').classList.contains('on'), 'edit button opens the bottle sheet');
  d.getElementById('bf-name').value = 'Campari Bitter';
  d.getElementById('bf-save').click(); await sleep(30);
  assert(w.eval('S.bottles.some(b=>b.name==="Campari Bitter")'), 'bottle edit saves a new name');

  // --- add bottle via UI form ---
  d.getElementById('btn-addbottle').click(); await sleep(30);
  d.getElementById('bf-name').value = 'Fever-Tree Ginger Beer';
  d.querySelector('#modal .bf-cat').value = 'mixer';
  d.querySelector('#modal .bf-sub').value = 'ginger beer';
  d.getElementById('bf-save').click(); await sleep(30);
  assert(w.eval('S.bottles.some(b=>b.name==="Fever-Tree Ginger Beer" && b.category==="mixer")'), 'add-bottle form creates a mixer bottle');

  // --- collapsible shelf groups with counts ---
  let whead = [...d.querySelectorAll('#shelf-list .cathead')].find(h=>h.dataset.cat==='whiskey');
  assert(whead.querySelector('.cnt').textContent==='2', 'category header shows a bottle count');
  whead.click(); await sleep(30);
  assert(w.eval('S.collapsedCats.includes("whiskey")'), 'tapping a header collapses the group');
  assert(![...d.querySelectorAll('#shelf-list .bname')].some(e=>e.textContent==='Eagle Rare'), 'collapsed group hides its bottles');
  d.getElementById('shelf-search').value='eagle';
  d.getElementById('shelf-search').dispatchEvent(new w.Event('input')); await sleep(20);
  assert([...d.querySelectorAll('#shelf-list .bname')].some(e=>e.textContent==='Eagle Rare'), 'search still finds bottles inside collapsed groups');
  d.getElementById('shelf-search').value='';
  d.getElementById('shelf-search').dispatchEvent(new w.Event('input')); await sleep(20);
  whead = [...d.querySelectorAll('#shelf-list .cathead')].find(h=>h.dataset.cat==='whiskey');
  whead.click(); await sleep(30);
  assert(!w.eval('S.collapsedCats.includes("whiskey")') && [...d.querySelectorAll('#shelf-list .bname')].some(e=>e.textContent==='Eagle Rare'), 'tapping again expands the group');

  // --- recipe CRUD via UI form ---
  w.eval('setTab("specs")');
  const specCount = d.querySelectorAll('#spec-list .rcard').length;
  assert(specCount===34, 'specs tab renders all 34 recipe cards');
  d.getElementById('btn-addrecipe').click(); await sleep(30);
  d.getElementById('rf-name').value = 'House Coquito';
  const ir = d.querySelector('#rf-ings .ingrow');
  ir.querySelector('.ir-qty').value = '2';
  ir.querySelector('.ir-kind').value = 'staple';
  ir.querySelector('.ir-kind').dispatchEvent(new w.Event('change'));
  await sleep(20);
  ir.querySelector('.ir-staple').value = 'coconut cream';
  d.getElementById('rf-house').checked = true;
  d.getElementById('rf-servings').value = '2';
  d.getElementById('rf-save').click(); await sleep(30);
  assert(w.eval('S.recipes.length')===35 && w.eval('S.recipes.some(r=>r.name==="House Coquito" && r.house===true)'), 'recipe form saves a new house recipe');
  assert(w.eval('S.recipes.find(r=>r.name==="House Coquito").servings')===2, 'the makes-N-drinks field saves');
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.name==="House Coquito")).makeable')===true, 'staple-only recipe is immediately makeable');
  const coqId = w.eval('S.recipes.find(r=>r.name==="House Coquito").id');
  w.eval('openRecipeDetail("'+coqId+'")'); await sleep(20);
  d.getElementById('rd-del').click(); await sleep(30);
  assert(w.eval('S.recipes.length')===34, 'recipe delete removes it');

  // --- specs filters ---
  const ginChip = [...d.querySelectorAll('#spec-filters .chip')].find(c=>c.dataset.f==='gin');
  ginChip.click(); await sleep(20);
  assert([...d.querySelectorAll('#spec-list .rname')].every(el=>{const n=el.textContent;return ['Negroni','Martini','Gimlet','Last Word','Tom Collins','French 75'].some(x=>n.includes(x));}), 'base-spirit chip filters to gin drinks');
  const mkChip = [...d.querySelectorAll('#spec-filters .chip')].find(c=>c.dataset.f==='__mk');
  mkChip.click(); await sleep(20);
  const mkDots = [...d.querySelectorAll('#spec-list .rcard .mdot')];
  assert(mkDots.length>0 && mkDots.every(el=>el.classList.contains('mk')||el.classList.contains('lw')), 'makeable-only shows only makeable gin drinks');
  w.eval('specFilter="all"; makeableOnly=false;');

  // --- acceptance: menu mode ---
  w.eval('S.recipes.find(r=>r.name==="Gimlet").house = true; save();');
  w.eval('setTab("menu")'); await sleep(20);
  assert(d.body.classList.contains('menuMode'), 'menu mode strips admin chrome (menuMode class hides tabbar/topbar)');
  const menuNames = [...d.querySelectorAll('#menu-body .mitem:not(.pour) .mname')].map(e=>e.textContent);
  assert(menuNames.length>0 && menuNames[0].includes('Gimlet') && menuNames[0].includes('★'), 'house drink pinned to the top of the menu with a ★');
  const makeableNames = JSON.parse(w.eval('JSON.stringify(S.recipes.filter(r=>recipeStatus(r).makeable).map(r=>r.name))'));
  assert(menuNames.length===makeableNames.length && menuNames.every(n=>makeableNames.some(m=>n.includes(m))), 'menu cocktails section lists exactly the makeable recipes');

  // sections: house specialties + cocktails + by the pour, grouped like a printed menu
  const secLabels = [...d.querySelectorAll('#menu-body .msec')].map(e=>e.textContent);
  assert(secLabels.join()==='house specialties,cocktails,by the pour', 'house drinks get their own section at the top');
  assert([...d.querySelectorAll('#menu-body .mitem.house .mname')].some(e=>e.textContent.includes('Gimlet'))
      && ![...d.querySelectorAll('#menu-body .mitem:not(.house):not(.pour) .mname')].some(e=>e.textContent.includes('Gimlet')),
      'a house drink lives only in the house section');
  const pourNames = [...d.querySelectorAll('#menu-body .prow .pn')].map(e=>e.textContent);
  assert(pourNames.length===5 && pourNames.includes('Sipsmith'), 'pour section lists the 5 stocked spirits & amari');
  const pourCats = [...d.querySelectorAll('#menu-body .mcat')].map(e=>e.textContent);
  assert(pourCats.join()==='tequila,whiskey,gin,amaro', 'pours grouped under liquor-category headers in order');
  const mijRow = [...d.querySelectorAll('#menu-body .prow')].find(r=>r.querySelector('.pn').textContent==='Mijenta Reposado');
  assert(mijRow && mijRow.querySelector('.pt').textContent==='reposado' && mijRow.querySelector('.dots')!==null, 'pour row reads name ..... subtype');
  assert(!pourNames.includes('Fever-Tree Ginger Beer') && !pourNames.includes('Angostura'), 'mixers and bitters stay off the pour list');
  w.eval('S.bottles.find(b=>b.name==="Mijenta Reposado").level="out"; renderMenu();'); await sleep(20);
  assert(![...d.querySelectorAll('#menu-body .prow .pn')].some(e=>e.textContent==='Mijenta Reposado'), 'an out bottle leaves the pour list');
  w.eval('S.bottles.find(b=>b.name==="Mijenta Reposado").level="full"; renderMenu();'); await sleep(20);

  // shareable menu link (payload rides in the #hash)
  const link = w.eval('buildMenuLink()');
  assert(typeof link==='string' && link.includes('#m='), 'share link embeds the menu in the URL hash');
  const hash = '#m=' + link.split('#m=')[1];
  const payload = JSON.parse(w.eval('JSON.stringify(parseMenuHash('+JSON.stringify(hash)+'))'));
  assert(payload && payload.t===w.eval('S.menuTitle') && payload.c.length===menuNames.length && payload.s.length===5, 'share payload round-trips title, cocktails, and pours');
  assert(w.eval('parseMenuHash("#m=!!!notvalid")')===null && w.eval('parseMenuHash("#nope")')===null, 'garbage share hashes are rejected');

  // short link via the worker (KV-backed)
  const shortUrl = await w.createMenuLink();
  assert(shortUrl.endsWith('/m/abc123'), 'worker returns a short /m/ link');
  assert((await w.createMenuLink())===shortUrl, 'short link is cached while the menu is unchanged');
  w.eval('_menuLink={key:null,url:null}');
  w.__menuPostFail = true;
  assert((await w.createMenuLink()).includes('#m='), 'worker outage falls back to the long link');
  w.__menuPostFail = false;
  w.eval('_menuLink={key:null,url:null}');
  w.__sharedPayload = { t:"Party at CJ's", c:[{ n:'Negroni', d:'gin, Campari, sweet vermouth', h:true }], s:[] };
  await w.loadSharedMenu('abc123'); await sleep(20);
  assert(d.body.classList.contains('menuMode') && d.querySelector('#menu-body .menu-head').textContent==="Party at CJ's",
    'a short link loads the shared menu from the worker');
  assert(d.getElementById('menu-share').classList.contains('hidden') && d.getElementById('menu-curate').classList.contains('hidden'),
    'guest view from a short link hides admin chrome');
  w.eval('sharedMenu=null; renderMenu();'); await sleep(20);
  w.eval('enterSharedMenu(parseMenuHash('+JSON.stringify(hash)+'))'); await sleep(20);
  assert(d.body.classList.contains('menuMode') && d.getElementById('menu-exit').classList.contains('hidden')
      && d.getElementById('menu-share').classList.contains('hidden') && d.getElementById('menu-curate').classList.contains('hidden'),
      'a shared link locks into the guest menu with zero admin controls');
  w.eval('sharedMenu=null; renderMenu();'); await sleep(20);

  // menu curation: pick which cocktails appear
  w.eval('openMenuPicker()'); await sleep(20);
  const mkIds = JSON.parse(w.eval('JSON.stringify(S.recipes.filter(r=>recipeStatus(r).makeable).map(r=>r.id))'));
  assert(d.querySelectorAll('#modal .mp-ck').length===mkIds.length, 'menu picker lists every makeable cocktail');
  const gimRow = [...d.querySelectorAll('#modal .mp-row')].find(r=>r.textContent.includes('Gimlet'));
  gimRow.querySelector('.mp-ck').checked = false;
  d.getElementById('mp-save').click(); await sleep(20);
  assert(w.eval('Array.isArray(S.menuSelection)') && w.eval('S.menuSelection.length')===mkIds.length-1, 'partial selection is saved');
  assert(![...d.querySelectorAll('#menu-body .mitem:not(.pour) .mname')].some(e=>e.textContent.includes('Gimlet')), 'unchecked cocktail leaves the menu');
  const curLink = w.eval('buildMenuLink()');
  const curPayload = JSON.parse(w.eval('JSON.stringify(parseMenuHash('+JSON.stringify('#m='+curLink.split('#m=')[1])+'))'));
  assert(!curPayload.c.some(x=>x.n==='Gimlet'), 'shared link respects the curated selection');
  w.eval('openMenuPicker()'); await sleep(20);
  d.getElementById('mp-all').click(); await sleep(20);
  assert(w.eval('S.menuSelection===null'), 'everything-makeable resets to automatic');
  assert([...d.querySelectorAll('#menu-body .mitem:not(.pour) .mname')].some(e=>e.textContent.includes('Gimlet')), 'menu shows all makeable again');

  // pour curation
  w.eval('openMenuPicker()'); await sleep(20);
  assert(d.querySelectorAll('#modal .mp-pk').length===5, 'menu picker also lists the 5 stocked pours');
  const sipPk = [...d.querySelectorAll('#modal .mp-pk')].find(el=>el.closest('label').textContent.includes('Sipsmith'));
  sipPk.checked = false;
  d.getElementById('mp-save').click(); await sleep(20);
  assert(w.eval('Array.isArray(S.pourSelection)') && w.eval('S.pourSelection.length')===4, 'partial pour selection is saved');
  assert(![...d.querySelectorAll('#menu-body .prow .pn')].some(e=>e.textContent==='Sipsmith'), 'unchecked pour leaves the menu');
  assert([...d.querySelectorAll('#menu-body .mitem:not(.pour) .mname')].some(e=>e.textContent.includes('Gimlet')), 'hiding a pour does not touch the cocktails');
  const pourLink = w.eval('buildMenuLink()');
  const pourPayload = JSON.parse(w.eval('JSON.stringify(parseMenuHash('+JSON.stringify('#m=')+' + '+JSON.stringify(pourLink.split('#m=')[1])+'))'));
  assert(!pourPayload.s.some(x=>x.n==='Sipsmith'), 'shared link respects the pour curation');
  w.eval('openMenuPicker()'); await sleep(20);
  d.getElementById('mp-all').click(); await sleep(20);
  assert(w.eval('S.pourSelection===null') && [...d.querySelectorAll('#menu-body .prow .pn')].some(e=>e.textContent==='Sipsmith'), 'show-everything restores all pours');

  // drink of the day/night (optional feature)
  w.eval('openMenuPicker()'); await sleep(20);
  d.getElementById('mp-feat').value = w.eval('S.recipes.find(r=>r.name==="Gimlet").id');
  d.getElementById('mp-featlbl').value = 'drink of the day';
  d.getElementById('mp-save').click(); await sleep(20);
  const secs2 = [...d.querySelectorAll('#menu-body .msec')].map(e=>e.textContent);
  assert(secs2[0]==='drink of the day', 'feature section tops the menu with your own label');
  assert(d.querySelector('#menu-body .mitem.feature .mname').textContent.includes('Gimlet'), 'the chosen drink gets top billing');
  assert([...d.querySelectorAll('#menu-body .mitem.house .mname')].every(e=>!e.textContent.includes('Gimlet')), 'featured drink is not repeated below');
  const featLink = w.eval('buildMenuLink()');
  const fPayload = JSON.parse(w.eval('JSON.stringify(parseMenuHash('+JSON.stringify('#m='+featLink.split('#m=')[1])+'))'));
  assert(fPayload.f && fPayload.f.n==='Gimlet' && fPayload.f.label==='drink of the day', 'share payload carries the feature');
  w.eval('openMenuPicker()'); await sleep(20);
  d.getElementById('mp-feat').value = '';
  d.getElementById('mp-save').click(); await sleep(20);
  assert(w.eval('S.featureId')===null && d.querySelector('#menu-body .mitem.feature')===null, 'the feature is optional and switches off cleanly');

  // 86'd: a drink whose bottle ran dry is struck through, not hidden
  w.eval('S.bottles.find(b=>b.name==="Sipsmith").level="out"; renderMenu();'); await sleep(20);
  const dead = [...d.querySelectorAll('#menu-body .mname.dead')].map(e=>e.textContent);
  assert(dead.length>0 && dead.some(n=>n.includes('Gimlet')), 'an emptied bottle 86s its drinks instead of hiding them');
  assert(d.querySelector('#menu-body .chip86')!==null, "86'd tag rendered next to the struck name");
  assert(!dead.some(n=>n.includes('Manhattan')), 'drinks that were never stocked stay hidden, not 86d');
  w.eval('S.bottles.find(b=>b.name==="Sipsmith").level="full"; renderMenu();'); await sleep(20);
  assert(d.querySelectorAll('#menu-body .mname.dead').length===0, 'restocking clears the 86 marks');

  assert(d.querySelectorAll('#view-menu button').length===4, 'admin menu chrome is just curate + share + requests + exit');
  d.getElementById('menu-exit').click(); await sleep(20);
  assert(!d.body.classList.contains('menuMode'), 'menu exit returns to admin');

  // --- acceptance: export -> wipe -> import restores everything ---
  const backup = w.eval('exportJSON()');
  w.eval('localStorage.clear(); S = fresh(); renderAll();');
  assert(w.eval('S.bottles.length')===0, 'wipe leaves an empty shelf');
  assert(w.eval('importJSON('+JSON.stringify(backup)+')')===null, 'importJSON accepts the backup');
  assert(w.eval('S.bottles.length')===7, 'import restores all 7 bottles');
  assert(w.eval('S.recipes.find(r=>r.name==="Gimlet").rating')===5 && w.eval('S.recipes.find(r=>r.name==="Gimlet").house')===true, 'import restores ratings and house flags');
  assert(w.eval('importJSON("{\\"nope\\":true}")')!==null, 'import rejects a non-backup JSON');
  assert(w.eval('importJSON("not json at all")')!==null, 'import rejects garbage text');

  // --- scan flow: mocked fetch -> confirm sheet -> selective add ---
  w.__scanResult = { bottles: [
    { name:'Amaro Nonino Quintessentia', category:'amaro', subtype:'nonino' },
    { name:'Dolin Rouge', category:'vermouth', subtype:'sweet' },
    { name:'Campari Bitter', category:'amaro', subtype:'campari' },      // duplicate of existing
    { name:'Weird Thing (unsure)', category:'not-a-category' },          // bad category -> other
  ]};
  const scanned = await w.requestScan('image/jpeg','aGVsbG8=');
  assert(Array.isArray(scanned) && scanned.length===4, 'requestScan posts to SCAN_URL and returns the bottle list');
  w.openConfirmSheet(scanned); await sleep(30);
  assert(d.querySelectorAll('#modal .scanrow').length===4, 'confirm sheet shows one row per detected bottle');
  const dupRow = [...d.querySelectorAll('#modal .scanrow')].find(r=>r.querySelector('.sr-name').value==='Campari Bitter');
  assert(dupRow.querySelector('.dup')!==null && dupRow.querySelector('.sr-ck').checked===false, 'duplicate bottle flagged and default-unchecked');
  const weirdRow = [...d.querySelectorAll('#modal .scanrow')].find(r=>r.querySelector('.sr-name').value.includes('Weird'));
  assert(weirdRow.querySelector('.sr-cat').value==='other', 'unknown category coerced to "other"');
  assert(d.getElementById('sr-commit').textContent==='Add 3 bottles', 'commit button counts checked rows');
  weirdRow.querySelector('.sr-ck').checked = false;
  weirdRow.querySelector('.sr-ck').dispatchEvent(new w.Event('change'));
  await sleep(20);
  assert(d.getElementById('sr-commit').textContent==='Add 2 bottles', 'unchecking a row updates the count');
  const before = w.eval('S.bottles.length');
  d.getElementById('sr-commit').click(); await sleep(30);
  assert(w.eval('S.bottles.length')===before+2, 'commit adds only the checked rows');
  assert(w.eval('S.bottles.some(b=>b.name==="Dolin Rouge" && b.category==="vermouth" && b.subtype==="sweet")'), 'scanned sweet vermouth lands on the shelf correctly');
  assert(w.eval('S.bottles.filter(b=>b.name==="Campari Bitter").length')===1, 'duplicate row stayed unchecked — no double bottle');
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.name==="Negroni")).makeable')===true, 'scanned vermouth completes the Negroni');

  // --- AI recipe draft: mocked fetch -> prefilled form -> save ---
  w.eval('setTab("specs")');
  d.getElementById('btn-addrecipe').click(); await sleep(30);
  assert(d.getElementById('rf-ai-text')!==null, 'new-recipe form offers the AI draft box');
  w.eval('closeModal()');
  w.__recipeResult = { recipe: { name:'Division Bell', method:'shake', glass:'coupe', garnish:'grapefruit twist', notes:'',
    ingredients: [
      { kind:'tag', category:'mezcal', qty:'1', unit:'oz' },
      { kind:'tag', category:'liqueur', subtype:'maraschino', qty:'0.75', unit:'oz' },
      { kind:'tag', category:'amaro', subtype:'aperol', qty:'0.75', unit:'oz' },
      { kind:'staple', staple:'lime', qty:'0.75', unit:'oz' },
      { kind:'tag', category:'other', subtype:'cinnamon', qty:'1', unit:'pinch' },
      { kind:'tag', category:'not-real', qty:'1', unit:'oz' },
    ] } };
  const rec = await w.requestRecipe({ text:'a mezcal last word riff' });
  assert(rec.name==='Division Bell', 'requestRecipe posts to RECIPE_URL and returns the draft');
  w.openRecipeForm(null, w.convertAiRecipe(rec)); await sleep(30);
  assert(d.getElementById('rf-name').value==='Division Bell', 'AI draft prefills the recipe name');
  assert(d.querySelectorAll('#rf-ings .ingrow').length===5, 'AI draft prefills valid ingredient rows and drops junk categories');
  assert([...d.querySelectorAll('#rf-ings .ingrow')][1].querySelector('.ir-sub').value==='maraschino', 'tag subtypes land in the form');
  assert([...d.querySelectorAll('#rf-ings .ingrow')][3].querySelector('.ir-staple').value==='lime', 'staple ingredients land in the form');
  assert([...d.querySelectorAll('#rf-ings .ingrow')][4].querySelector('.ir-staple').value==='cinnamon', 'pantry items filed under tag/other become staples');
  d.getElementById('rf-save').click(); await sleep(30);
  assert(w.eval('S.recipes.some(r=>r.name==="Division Bell")'), 'drafted recipe saves like any other');
  w.eval('deleteRecipe(S.recipes.find(r=>r.name==="Division Bell").id)');

  // --- specific-bottle type-to-search ---
  d.getElementById('btn-addrecipe').click(); await sleep(30);
  const brow = d.querySelector('#rf-ings .ingrow');
  brow.querySelector('.ir-kind').value = 'bottleId';
  brow.querySelector('.ir-kind').dispatchEvent(new w.Event('change')); await sleep(20);
  const opts = [...brow.querySelectorAll('datalist option')].map(o=>o.value);
  assert(opts.length===w.eval('S.bottles.length') && opts[0]==='Amaro Nonino Quintessentia', 'bottle picker is a sorted type-to-search list');
  d.getElementById('rf-name').value = 'Bottle Test';
  brow.querySelector('.ir-qty').value = '2';
  brow.querySelector('.ir-bottle').value = 'nonexistent bottle';
  d.getElementById('rf-save').click(); await sleep(30);
  assert(!w.eval('S.recipes.some(r=>r.name==="Bottle Test")') && d.getElementById('modalwrap').classList.contains('on'), 'an unknown bottle name blocks the save with the form intact');
  brow.querySelector('.ir-bottle').value = 'campari bitter';
  d.getElementById('rf-save').click(); await sleep(30);
  const bt = 'S.recipes.find(r=>r.name==="Bottle Test")';
  assert(w.eval(bt+'.ingredients[0].req.bottleId')===w.eval('S.bottles.find(b=>b.name==="Campari Bitter").id'), 'a typed name resolves to the bottle id, case-insensitively');

  // --- servings + portion scaling ---
  assert(w.eval('UNITS.includes("cup") && UNITS.includes("gallon")'), 'cup and gallon are valid units');
  w.upsertRecipe({ name:'Batch Test', method:'stir', glass:'pitcher', garnish:'', notes:'', rating:0, house:false, servings:2,
    ingredients:[ { qty:'1.5', unit:'cup', req:{ staple:'coconut cream' } }, { qty:'4', unit:'oz', req:{ tag:{ category:'rum', subtype:'aged' } } } ] });
  w.eval('openRecipeDetail(S.recipes.find(r=>r.name==="Batch Test").id)'); await sleep(20);
  assert(d.querySelector('#modal .detmeta').textContent.includes('makes 2'), 'detail sheet shows how many drinks the spec makes');
  d.getElementById('rd-scale').value = '20';
  d.getElementById('rd-scale').dispatchEvent(new w.Event('input')); await sleep(20);
  const qtys = [...d.querySelectorAll('#rd-ings .qty')].map(e=>e.textContent.trim());
  assert(qtys[0]==='15 cup' && qtys[1]==='40 oz', 'scaling 2 -> 20 drinks multiplies every quantity by 10');
  d.getElementById('rd-scale').value = '3';
  d.getElementById('rd-scale').dispatchEvent(new w.Event('input')); await sleep(20);
  assert([...d.querySelectorAll('#rd-ings .qty')][0].textContent.trim()==='2.25 cup', 'fractional scaling rounds sensibly');
  w.eval('closeModal(); deleteRecipe(S.recipes.find(r=>r.name==="Batch Test").id); deleteRecipe(S.recipes.find(r=>r.name==="Bottle Test").id);');

  // --- wishlist with photos ---
  w.eval('setTab("tonight")');
  assert(d.getElementById('wish-list')!==null && d.getElementById('btn-addwish')!==null, 'Tonight tab has a wishlist section');
  d.getElementById('btn-addwish').click(); await sleep(20);
  d.getElementById('wf-name').value = 'Chartreuse V.E.P.';
  d.getElementById('wf-notes').value = 'saw it at the shop downtown';
  d.getElementById('wf-save').click(); await sleep(30);
  assert(w.eval('S.wishlist.length')===1 && w.eval('S.wishlist[0].notes').includes('downtown'), 'wishlist add saves name + notes');
  assert([...d.querySelectorAll('#wish-list .wname')].some(e=>e.textContent==='Chartreuse V.E.P.'), 'wish renders on Tonight');
  w.eval('S.wishlist[0].img="data:image/jpeg;base64,aGVsbG8="; save(); renderTonight();'); await sleep(20);
  assert(d.querySelector('#wish-list img.wthumb')!==null, 'wish photo renders as a thumbnail');
  d.querySelector('#wish-list .wish').click(); await sleep(20);
  assert(d.getElementById('wf-name').value==='Chartreuse V.E.P.' && d.querySelector('#wf-photo img')!==null, 'tapping a wish opens it for editing with its photo');
  d.getElementById('wf-del').click(); await sleep(30);
  assert(w.eval('S.wishlist.length')===0, 'wish delete removes it');
  // wishlist survives export -> wipe -> import
  w.eval('upsertWish({name:"Islay dream", notes:"", img:"data:image/jpeg;base64,aGk="})');
  const wlBackup = w.eval('exportJSON()');
  const bottleCount = w.eval('S.bottles.length');
  w.eval('localStorage.clear(); S = fresh(); renderAll();');
  assert(w.eval('importJSON('+JSON.stringify(wlBackup)+')')===null, 'backup with wishlist imports');
  assert(w.eval('S.wishlist.length')===1 && w.eval('S.wishlist[0].img').startsWith('data:image') && w.eval('S.bottles.length')===bottleCount, 'wishlist photos survive the backup round-trip');

  // --- tap an unlock -> wishlist ---
  w.eval('setTab("tonight")');
  let uwBtn = [...d.querySelectorAll('#unlock-list .uw')].find(b=>b.dataset.label==='orange liqueur');
  assert(!!uwBtn, 'unlock rows offer a +wishlist button');
  uwBtn.click(); await sleep(30);
  assert(w.eval('S.wishlist.some(x=>x.name==="orange liqueur")'), 'tapping it adds the bottle to the wishlist');
  uwBtn = [...d.querySelectorAll('#unlock-list .uw')].find(b=>b.dataset.label==='orange liqueur');
  uwBtn.click(); await sleep(30);
  assert(w.eval('S.wishlist.filter(x=>x.name==="orange liqueur").length')===1, 'tapping again does not duplicate');

  // --- automatic cloud backup ---
  w.eval('enableSync()'); await sleep(250);
  const tok = w.eval('SYNC.token');
  assert(/^[a-f0-9]{32}$/.test(tok), 'enabling cloud backup mints a 32-hex backup code');
  assert(w.__syncStore && w.__syncStore[tok] && JSON.parse(w.__syncStore[tok]).v===1, 'state is pushed to the worker');
  assert(JSON.parse(w.__syncStore[tok]).bottles.length===w.eval('S.bottles.length'), 'the pushed backup matches the live shelf');
  const altCode = 'b'.repeat(32);
  const alt = JSON.parse(w.eval('exportJSON()')); alt.menuTitle = 'Restored Bar';
  w.__syncStore[altCode] = JSON.stringify(alt);
  assert((await w.syncRestore(altCode))===null, 'restore-from-code succeeds');
  assert(w.eval('S.menuTitle')==='Restored Bar' && w.eval('SYNC.token')===altCode, 'restore replaces state and adopts the new code');
  assert(typeof (await w.syncRestore('not-a-code'))==='string', 'a malformed code is rejected politely');
  assert(typeof (await w.syncRestore('c'.repeat(32)))==='string', 'an unknown code reports no backup found');

  // --- AI bartender ---
  w.eval('setTab("tonight")'); await sleep(20);
  assert(!d.getElementById('bartender-box').classList.contains('hidden'), 'bartender box shows when drinks are makeable');
  w.__bartenderResult = { picks: [
    { name:'Gimlet', why:'Bright and cold, and your gin is singing tonight.' },
    { name:'Not A Real Drink', why:'should be filtered out' } ] };
  d.getElementById('bt-mood').value = 'long day';
  d.getElementById('bt-ask').click(); await sleep(100);
  assert(d.querySelectorAll('#modal .rcard').length===1, 'bartender modal keeps only picks that actually exist');
  assert(d.querySelector('#modal .rcard .rname').textContent.includes('Gimlet'), 'the valid pick renders with its reasoning');
  d.querySelector('#modal .rcard').click(); await sleep(30);
  assert(d.getElementById('rd-scale')!==null, 'tapping a pick opens the full spec');
  w.eval('closeModal()');

  // --- guest drink requests ---
  w.__reqStore = [];
  w.__sharedPayload = { t:'Party', c:[{ n:'Negroni', d:'gin, Campari, sweet vermouth', h:false }], s:[] };
  await w.loadSharedMenu('abc123'); await sleep(30);
  const gItem = d.querySelector('#menu-body .mitem[data-n]');
  assert(!!gItem && d.getElementById('menu-body').textContent.includes('tap a drink'), 'guest menu invites tapping a drink to request it');
  gItem.click(); await sleep(20);
  d.getElementById('rq-guest').value = 'Maria';
  d.getElementById('rq-send').click(); await sleep(60);
  assert(w.__reqStore.length===1 && w.__reqStore[0].drink==='Negroni' && w.__reqStore[0].guest==='Maria', 'a guest request posts to the worker');
  w.eval('sharedMenu=null; sharedMenuId=null; renderMenu();'); await sleep(120);
  assert(!d.getElementById('menu-reqs').classList.contains('hidden'), 'the host sees the request bell in admin menu mode');
  assert(d.getElementById('menu-reqs').textContent.includes('1'), 'the bell shows the request count');
  await w.openRequestInbox(); await sleep(60);
  assert(d.getElementById('modal').textContent.includes('Negroni') && d.getElementById('modal').textContent.includes('Maria'), 'the inbox lists who wants what');
  d.getElementById('rq-clear').click(); await sleep(80);
  assert(w.__reqStore.length===0, 'clear-all empties the request box');
  w.eval('closeModal(); setTab("shelf");');

  // --- menu descriptions: capped auto + owner override ---
  w.upsertRecipe({ name:'Test Coquito', method:'blend', glass:'rocks', garnish:'', notes:'', rating:0, house:false,
    ingredients:[
      { qty:'2', unit:'oz', req:{ tag:{ category:'rum', subtype:'aged' } } },
      { qty:'4', unit:'oz', req:{ staple:'coconut milk' } },
      { qty:'4', unit:'oz', req:{ staple:'condensed milk' } },
      { qty:'1', unit:'pinch', req:{ staple:'cinnamon' } },
      { qty:'1', unit:'pinch', req:{ staple:'nutmeg' } } ] });
  const cq = 'S.recipes.find(r=>r.name==="Test Coquito")';
  const ad = w.eval('autoDesc('+cq+')');
  assert(ad.startsWith('aged rum, coconut milk, condensed milk') && ad.endsWith('…') && !ad.includes('nutmeg'),
    'auto description leads with alcohol and caps the pantry list');
  w.eval('upsertBottle({name:"Diplomatico", category:"rum", subtype:"aged", level:"full"})');
  w.eval(cq+'.menuDesc="Puerto Rican Christmas in a glass"; save();');
  w.eval('setTab("menu")'); await sleep(20);
  const cqItem = [...d.querySelectorAll('#menu-body .mitem:not(.pour)')].find(el=>el.querySelector('.mname').textContent.includes('Test Coquito'));
  assert(cqItem && cqItem.querySelector('.mdesc').textContent==='Puerto Rican Christmas in a glass', 'menu description override is what guests see');
  w.eval('openRecipeDetail('+cq+'.id)'); await sleep(20);
  assert(d.getElementById('rd-mdesc').value==='Puerto Rican Christmas in a glass', 'detail sheet exposes the menu description');
  d.getElementById('rd-mdesc').value = 'Coquito, the family way';
  d.getElementById('rd-mdesc').dispatchEvent(new w.Event('change')); await sleep(20);
  assert(w.eval(cq+'.menuDesc')==='Coquito, the family way', 'editing the description in the detail sheet saves');
  w.eval('closeModal()');
  w.eval('deleteRecipe('+cq+'.id)');
  w.eval('deleteBottle(S.bottles.find(b=>b.name==="Diplomatico").id)');
  w.eval('setTab("shelf")');

  // --- persistence + migration guard ---
  await sleep(600); // let the debounced save flush
  const persisted = w.eval('JSON.parse(localStorage.getItem("bar-v1")||"null")');
  assert(persisted && persisted.v===1 && persisted.bottles.length===w.eval('S.bottles.length'), 'state persists to localStorage under bar-v1');
  w.eval('localStorage.setItem("bar-v1", JSON.stringify({v:99, alien:true}))');
  assert(w.eval('load().recipes.length')===34 && w.eval('load().bottles.length')===0, 'unknown schema version -> clean fresh state');
  assert(w.eval('!!localStorage.getItem("bar-v1-backup")'), 'migration guard keeps a backup of the unknown blob');
  w.eval('localStorage.setItem("bar-v1", "corrupted{{{")');
  assert(w.eval('load().recipes.length')===34, 'corrupted storage -> clean fresh state, no crash');

  assert(errors.length===0, 'no runtime errors across the whole run'+(errors.length?' -> '+errors.join(' | '):''));
  console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nall green');
})();
