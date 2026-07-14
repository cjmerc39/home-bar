const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously', url: 'https://example.com/',
  beforeParse(w){ w.TextEncoder=TextEncoder; w.TextDecoder=TextDecoder; w.confirm=()=>true; w.scrollTo=()=>{};
    try{ w.Object.defineProperty(w.Document.prototype, 'visibilityState', { configurable:true, get:()=> 'visible' }); }catch(e){}
    w.fetch = async (url, opts) => {
      const u = String(url);
      if(u.includes('/scan')) return { ok:true, status:200, json: async () => (w.__scanResult || { bottles: [] }) };
      if(u.includes('/recipe')) return { ok:true, status:200, json: async () => (w.__recipeResult || { error:'no mock' }) };
      if(u.includes('/sync')){
        const tok = String((opts&&opts.headers&&(opts.headers.Authorization||opts.headers.authorization))||'').replace('Bearer ','');
        if(opts && opts.method==='PUT'){
          w.__syncStore = w.__syncStore || {};
          w.__syncStore[tok] = opts.body;
          w.__syncPuts = (w.__syncPuts||0) + 1;
          return { ok:true, status:200, json: async()=>({ok:true}), text: async()=>'{"ok":true}' };
        }
        const v = (w.__syncStore||{})[tok];
        return v ? { ok:true, status:200, json: async()=>JSON.parse(v), text: async()=>v }
                 : { ok:false, status:404, json: async()=>({error:'nf'}), text: async()=>'{"error":"nf"}' };
      }
      if(u.includes('open-meteo')){
        if(w.__wxFail) return { ok:false, status:500, json: async () => ({}) };
        return { ok:true, status:200, json: async () => (w.__wxResult || {}) };
      }
      if(u.includes('/concierge')){
        w.__ccBodies = w.__ccBodies || [];
        w.__ccBodies.push(String(opts && opts.body || ''));
        return { ok:true, status:200, json: async () => (w.__ccResult || { reply:'…' }) };
      }
      if(u.includes('/bartender')){
        w.__bartenderBodies = w.__bartenderBodies || [];
        w.__bartenderBodies.push(String(opts && opts.body || ''));
        return { ok:true, status:200, json: async () => (w.__bartenderResult || { picks: [] }) };
      }
      if(u.includes('/req')){
        const auth = String((opts&&opts.headers&&(opts.headers.Authorization||opts.headers.authorization))||'');
        if(opts && opts.method === 'POST'){ w.__reqStore = w.__reqStore || []; w.__reqStore.push(JSON.parse(opts.body)); return { ok:true, status:200, json: async () => ({ ok:true, count:w.__reqStore.length }) }; }
        w.__lastReqAuth = auth;
        if(opts && opts.method === 'DELETE'){ w.__reqStore = []; return { ok:true, status:200, json: async () => ({ ok:true }) }; }
        return { ok:true, status:200, json: async () => ({ requests: (w.__reqStore||[]).map((x,i) => ({ d:x.drink, g:x.guest, at:1700000000000+i })) }) };
      }
      if(u.includes('/push')){
        if(u.includes('/push/vapid')) return { ok:true, status:200, json: async () => ({ key:'BFakeKey' }) };
        w.__pushPosts = w.__pushPosts || [];
        if(opts && opts.method === 'POST'){
          w.__pushPosts.push({ auth: String(opts.headers && (opts.headers.Authorization||opts.headers.authorization) || ''), body: String(opts.body||'') });
          return { ok:true, status:200, json: async () => ({ ok:true }) };
        }
        if(opts && opts.method === 'DELETE'){ w.__pushDeletes = (w.__pushDeletes||0)+1; return { ok:true, status:200, json: async () => ({ ok:true }) }; }
        return { ok:false, status:404, json: async () => ({}) };
      }
      if(u.includes('/menu')){
        if(opts && opts.method === 'POST'){
          if(w.__menuPostFail) return { ok:false, status:500, json: async () => ({ error:'kv down' }) };
          w.__menuPosts = (w.__menuPosts||0) + 1;
          return { ok:true, status:200, json: async () => ({ id:'abc123', owner:'a'.repeat(32) }) };
        }
        if(opts && opts.method === 'PUT'){
          w.__menuPuts = w.__menuPuts || [];
          w.__menuPuts.push({ url:u, auth:String((opts.headers&&(opts.headers.Authorization||opts.headers.authorization))||''), body:opts.body });
          if(w.__menuPutStatus) return { ok:false, status:w.__menuPutStatus, json: async () => ({ error:'x' }) };
          return { ok:true, status:200, json: async () => ({ ok:true }) };
        }
        if(opts && opts.method === 'DELETE'){ w.__menuDeleted = u; return { ok:true, status:200, json: async () => ({ ok:true }) }; }
        if(w.__menuGetGone) return { ok:false, status:404, json: async () => ({ error:'menu expired' }) };
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
  assert(w.eval('S.recipes.length')===81, 'seeds 81 classic recipes');
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
  assert(!!sv && sv.recipes.length===5 && ['Manhattan','Negroni','Boulevardier','Americano','Milano-Torino'].every(n=>sv.recipes.includes(n)),
    'sweet vermouth unlock groups Manhattan+Negroni+Boulevardier+Americano+Milano-Torino (5)');
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

  // --- delete with Undo (replaces the confirm) ---
  const delName = 'Fever-Tree Ginger Beer';
  const preIdx = w.eval('S.bottles.findIndex(b=>b.name==="'+delName+'")');
  const preCount = w.eval('S.bottles.length');
  w.eval('deleteBottle(S.bottles.find(b=>b.name==="'+delName+'").id)'); await sleep(20);
  assert(w.eval('S.bottles.length')===preCount-1, 'delete removes the bottle immediately');
  let undoBtn = d.querySelector('#toast .tact');
  assert(!!undoBtn && /Undo/.test(undoBtn.textContent), 'an Undo toast appears');
  undoBtn.click(); await sleep(20);
  assert(w.eval('S.bottles.length')===preCount && w.eval('S.bottles.findIndex(b=>b.name==="'+delName+'")')===preIdx, 'Undo restores the bottle at its original index');
  w.eval('deleteBottle(S.bottles.find(b=>b.name==="'+delName+'").id)'); await sleep(20);
  assert(w.eval('S.bottles.length')===preCount-1, 'without tapping Undo the delete stands');
  d.querySelector('#toast .tact').click(); await sleep(20); // restore for the tests downstream
  // bottle notes surface on the shelf (admin only)
  w.eval('S.bottles.find(b=>b.name==="'+delName+'").notes="Kerrin gave me this one"; save(); renderShelf();'); await sleep(20);
  assert([...d.querySelectorAll('#shelf-list .bnote')].some(e=>e.textContent==='Kerrin gave me this one'), 'bottle notes render on the shelf row');
  w.eval('S.bottles.find(b=>b.name==="'+delName+'").notes=""; save();');

  // --- recipe CRUD via UI form ---
  w.eval('setTab("specs")');
  const specCount = d.querySelectorAll('#spec-list .rcard').length;
  assert(specCount===81, 'specs tab renders all 81 recipe cards');
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
  assert(w.eval('S.recipes.length')===82 && w.eval('S.recipes.some(r=>r.name==="House Coquito" && r.house===true)'), 'recipe form saves a new house recipe');
  assert(w.eval('S.recipes.find(r=>r.name==="House Coquito").servings')===2, 'the makes-N-drinks field saves');
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.name==="House Coquito")).makeable')===true, 'staple-only recipe is immediately makeable');
  const coqId = w.eval('S.recipes.find(r=>r.name==="House Coquito").id');
  w.eval('openRecipeDetail("'+coqId+'")'); await sleep(20);
  d.getElementById('rd-del').click(); await sleep(30);
  assert(w.eval('S.recipes.length')===81, 'recipe delete removes it');

  // --- restore missing classics ---
  w.eval('S.recipes.find(r=>r.id==="r01").name = "Old Fashioned (CJ cut)"; save();');
  w.eval('deleteRecipe("r17")'); await sleep(20); // Mai Tai, recoverable
  assert(!w.eval('S.recipes.some(r=>r.id==="r17")'), 'a deleted classic is really gone');
  w.eval('openSettings()'); await sleep(20);
  d.getElementById('st-classics').click(); await sleep(20);
  assert(w.eval('S.recipes.some(r=>r.id==="r17" && r.name==="Mai Tai")'), 'restore-missing-classics brings back only the absent id');
  assert(w.eval('S.recipes.find(r=>r.id==="r01").name')==='Old Fashioned (CJ cut)', 'an edited seed recipe is never overwritten');
  d.getElementById('st-classics').click(); await sleep(20);
  assert(w.eval('S.recipes.length')===81, 'a second run adds nothing');
  w.eval('closeModal(); S.recipes.find(r=>r.id==="r01").name="Old Fashioned"; save();'); await sleep(20);

  // --- IBA expansion: an old install picks up the new seeds via the same restore flow ---
  w.eval('S.recipes = S.recipes.filter(r=>!["r53","r72","r81"].includes(r.id)); save();'); // an install from before the expansion
  assert(w.eval('S.recipes.length')===78, 'the pre-expansion install is missing the new drinks');
  w.eval('openSettings()'); await sleep(20);
  d.getElementById('st-classics').click(); await sleep(20);
  assert(w.eval('S.recipes.length')===81 && ['Caipirinha','Garibaldi','Trinidad Sour'].every(n=>w.eval('S.recipes.some(r=>r.name==='+JSON.stringify(n)+')')),
    'restore-missing-classics carries the IBA expansion to an old install');
  w.eval('closeModal()'); await sleep(20);

  // --- IBA expansion: every seed has hand-placed flavor coordinates ---
  assert(w.eval('seedRecipes().every(r=>r.flavor && isFinite(r.flavor.x) && isFinite(r.flavor.y))'), 'every seeded classic carries flavor-galaxy coordinates');
  assert(w.eval('Object.keys(SEED_FLAVORS).length')===81, 'SEED_FLAVORS covers all 81 seeds');

  // --- IBA expansion: new recipes become makeable with the right bottles ---
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.name==="Caipirinha")).makeable')===false, 'Caipirinha waits on cachaça');
  w.eval('upsertBottle({name:"Novo Fogo", category:"rum", subtype:"cachaca", level:"full"})');
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.name==="Caipirinha")).makeable')===true, 'a cachaça bottle makes the Caipirinha (lime + sugar are staples)');
  w.eval('upsertBottle({name:"Carpano Antica", category:"vermouth", subtype:"sweet", level:"full"})');
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.name==="Americano")).makeable')===true, 'Americano makeable with Campari + sweet vermouth (soda never gates)');
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.name==="Milano-Torino")).makeable')===true, 'Milano-Torino makeable with the same two bottles');
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.name==="Trinidad Sour")).makeable')===true, 'Trinidad Sour makeable off bitters + rye (orgeat never gates)');
  w.eval('S.bottles = S.bottles.filter(b=>!["Novo Fogo","Carpano Antica"].includes(b.name)); save(); renderAll();'); // leave the shelf as the later tests expect

  // --- IBA expansion: the derived systems produce sane output for the new seeds ---
  const cSunrise = JSON.parse(w.eval('JSON.stringify(colorOf(S.recipes.find(r=>r.id==="r67")))'));
  assert(cSunrise.r>cSunrise.g && cSunrise.g>cSunrise.b, 'Tequila Sunrise renders warm (r>g>b)');
  assert(JSON.parse(w.eval('JSON.stringify(colorOf(S.recipes.find(r=>r.id==="r52")))')).opacity>=.9, 'Bloody Mary goes opaque (tomato juice)');
  const nySteps = JSON.parse(w.eval('JSON.stringify(stepsFor(S.recipes.find(r=>r.id==="r76")))'));
  assert(nySteps.some(s=>/Float the red wine/.test(s) && /holds/.test(s)), 'New York Sour steps float the red wine — and the physics says it holds');
  const caiSteps = JSON.parse(w.eval('JSON.stringify(stepsFor(S.recipes.find(r=>r.id==="r53")))'));
  assert(caiSteps.length>0 && caiSteps.some(s=>/cachaça/.test(s)), 'Caipirinha build steps pour the cachaça');
  assert(w.eval('glassFor(S.recipes.find(r=>r.id==="r63").glass).key')==='rocks', 'a copper mug lands on a sane glass shape');
  assert(w.eval('tagLabel({category:"rum",subtype:"cachaca"})')==='cachaça' && w.eval('tagLabel({category:"brandy",subtype:"cognac"})')==='cognac', 'new tags read cleanly');

  // --- specs search: by name and by ingredient (reverse lookup) ---
  d.getElementById('spec-search').value = 'campari';
  d.getElementById('spec-search').dispatchEvent(new w.Event('input')); await sleep(20);
  const found = [...d.querySelectorAll('#spec-list .rname')].map(e=>e.textContent);
  assert(found.length===6 && ['Negroni','Boulevardier','Jungle Bird','Americano','Garibaldi','Milano-Torino'].every(n=>found.some(f=>f.includes(n))),
    'searching an ingredient finds every drink that uses it');
  d.getElementById('spec-search').value = 'daiq';
  d.getElementById('spec-search').dispatchEvent(new w.Event('input')); await sleep(20);
  assert([...d.querySelectorAll('#spec-list .rname')].length===2, 'name search still works (both Daiquiris)');
  d.getElementById('spec-search').value = '';
  d.getElementById('spec-search').dispatchEvent(new w.Event('input')); await sleep(20);

  // --- specs filters ---
  const ginChip = [...d.querySelectorAll('#spec-filters .chip')].find(c=>c.dataset.f==='gin');
  ginChip.click(); await sleep(20);
  assert([...d.querySelectorAll('#spec-list .rname')].every(el=>{const n=el.textContent;return ['Negroni','Martini','Gimlet','Last Word','Tom Collins','French 75','Aviation','Casino','Clover Club','Gin Fizz','Hanky Panky','Martinez','Tuxedo','White Lady','Corpse Reviver','Vesper',"Bee's Knees",'Southside','Suffering Bastard','Singapore Sling'].some(x=>n.includes(x));}), 'base-spirit chip filters to gin drinks');
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

  // stable short link: one id per bar, POST once, PUT in place on change
  w.__menuPosts = 0; w.__menuPuts = [];
  w.eval('S.menuId=null; S.menuOwner=null; _menuPush={key:null,url:null};');
  const u1 = await w.ensureMenuLink();
  assert(u1.endsWith('/m/abc123') && w.__menuPosts===1 && w.eval('S.menuId')==='abc123' && /^a{32}$/.test(w.eval('S.menuOwner')),
    'first share POSTs once and stores the id + owner in S');
  assert((await w.ensureMenuLink())===u1 && w.__menuPosts===1 && w.__menuPuts.length===0, 'unchanged payload costs zero requests');
  w.eval('S.beerWine=["Stable Link Ale"];');
  const u3 = await w.ensureMenuLink();
  assert(u3===u1 && w.__menuPosts===1 && w.__menuPuts.length===1
      && w.__menuPuts[0].url.endsWith('/menu/abc123') && w.__menuPuts[0].auth==='Bearer ' + 'a'.repeat(32),
    'a payload change PUTs to the SAME id with the owner token — never a new POST');
  w.eval('S.beerWine=[];'); await w.ensureMenuLink();
  w.__menuPutStatus = 500; w.__menuPostFail = true;
  w.eval('S.beerWine=["Offline Beer"];');
  assert((await w.ensureMenuLink()).includes('#m=') && w.eval('S.menuId')==='abc123', 'worker outage falls back to the long link without losing the id');
  w.__menuPutStatus = 0; w.__menuPostFail = false;
  w.eval('S.beerWine=[];'); await w.ensureMenuLink();

  w.__sharedPayload = { t:"Party at CJ's", c:[{ n:'Negroni', d:'gin, Campari, sweet vermouth', h:true }], s:[] };
  await w.loadSharedMenu('abc123'); await sleep(20);
  assert(d.body.classList.contains('menuMode') && d.querySelector('#menu-body .menu-head').textContent==="Party at CJ's",
    'a short link loads the shared menu from the worker');
  assert(d.getElementById('menu-share').classList.contains('hidden') && d.getElementById('menu-curate').classList.contains('hidden'),
    'guest view from a short link hides admin chrome');

  // guest live refetch: 86'd bottles reach phones that already loaded the menu
  w.__sharedPayload = { t:'Party v2', c:[{ n:'Negroni', d:'ran dry', h:true, x:true }], s:[] };
  d.dispatchEvent(new w.Event('visibilitychange')); await sleep(60);
  assert(d.querySelector('#menu-body .menu-head').textContent==='Party v2' && d.querySelector('#menu-body .mname.dead')!==null,
    'a visibility refresh re-renders the changed payload — 86 marks reach the guest');
  w.__menuGetGone = true;
  d.dispatchEvent(new w.Event('visibilitychange')); await sleep(60);
  assert(d.querySelector('#menu-body .menu-head').textContent==='Party v2', 'a 404 after a successful load keeps the last rendered menu');
  w.__menuGetGone = false;
  w.eval('sharedMenu=null; sharedMenuId=null; _guestKey=null; _guestWarned=false; if(_guestT){clearInterval(_guestT); _guestT=null;} renderMenu();'); await sleep(50);
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

  // tabbed picker + beer & wine
  w.eval('openMenuPicker()'); await sleep(20);
  assert(d.querySelectorAll('#mp-tabs button').length===5, 'menu picker has five tabs (theme pane added)');
  const bwTab = [...d.querySelectorAll('#mp-tabs button')].find(b=>b.textContent.includes('Beer'));
  bwTab.click(); await sleep(20);
  assert(!d.querySelector('#modal .mp-pane[data-p="2"]').classList.contains('hidden')
      && d.querySelector('#modal .mp-pane[data-p="0"]').classList.contains('hidden'), 'tab switch shows the beer & wine pane');
  assert(w.eval('BEERWINE_CATALOG.length')>=120, 'catalog ships 120+ beers, wine styles, and brands');
  const bwin = d.getElementById('mp-bwin');
  bwin.value = 'modelo';
  bwin.dispatchEvent(new w.Event('input',{bubbles:true})); await sleep(20);
  const bwSg = [...d.querySelectorAll('#modal .suggest .sg-item')];
  assert(bwSg.some(x=>x.textContent==='Modelo Especial'), 'typing suggests catalog beers');
  bwSg.find(x=>x.textContent==='Modelo Especial').dispatchEvent(new w.Event('mousedown',{bubbles:true})); await sleep(20);
  assert(bwin.value==='Modelo Especial', 'tapping a suggestion fills the field');
  d.getElementById('mp-bwadd').click(); await sleep(20);
  bwin.value = 'Sangria de la Casa';
  d.getElementById('mp-bwadd').click(); await sleep(20);
  assert(d.querySelectorAll('#mp-bwlist .rowline').length===2, 'catalog pick and custom entry both queue up');
  bwin.value = 'modelo especial';
  d.getElementById('mp-bwadd').click(); await sleep(20);
  assert(d.querySelectorAll('#mp-bwlist .rowline').length===2, 'duplicates are refused');
  d.getElementById('mp-save').click(); await sleep(20);
  assert(w.eval('S.beerWine.length')===2 && w.eval('S.beerWine.includes("Modelo Especial")'), 'beer & wine list saves');
  assert(w.eval('S.customBW.includes("Sangria de la Casa")') && !w.eval('S.customBW.includes("Modelo Especial")'),
    'new entries are remembered for autocomplete; catalog ones are not re-saved');
  w.eval('openMenuPicker()'); await sleep(20);
  d.getElementById('mp-bwin').dispatchEvent(new w.Event('input',{bubbles:true})); await sleep(20);
  assert([...d.querySelectorAll('#modal .suggest .sg-item')][0].textContent==='Sangria de la Casa', 'your own entries suggest first next time');
  w.eval('closeModal()');
  const bwNames = [...d.querySelectorAll('#menu-body .mitem.bw .mname')].map(e=>e.textContent);
  assert(bwNames.length===2 && bwNames[0]==='Modelo Especial', 'beer & wine section renders on the menu');
  const bwSecs = [...d.querySelectorAll('#menu-body .msec')].map(e=>e.textContent);
  assert(bwSecs.indexOf('beer & wine') > bwSecs.indexOf('cocktails') && bwSecs.indexOf('beer & wine') < bwSecs.indexOf('by the pour'),
    'beer & wine sits after cocktails, above by the pour');
  const bwLink = w.eval('buildMenuLink()');
  const bwPayload = JSON.parse(w.eval('JSON.stringify(parseMenuHash('+JSON.stringify('#m=')+' + '+JSON.stringify(bwLink.split('#m=')[1])+'))'));
  assert(Array.isArray(bwPayload.b) && bwPayload.b.length===2, 'share payload carries beer & wine');
  w.eval('S.beerWine=[]; save(); renderMenu();'); await sleep(20);
  assert(d.querySelector('#menu-body .mitem.bw')===null, 'clearing the list removes the section');

  // 86'd: a drink whose bottle ran dry is struck through, not hidden
  w.eval('S.bottles.find(b=>b.name==="Sipsmith").level="out"; renderMenu();'); await sleep(20);
  const dead = [...d.querySelectorAll('#menu-body .mname.dead')].map(e=>e.textContent);
  assert(dead.length>0 && dead.some(n=>n.includes('Gimlet')), 'an emptied bottle 86s its drinks instead of hiding them');
  assert(d.querySelector('#menu-body .chip86')!==null, "86'd tag rendered next to the struck name");
  assert(!dead.some(n=>n.includes('Manhattan')), 'drinks that were never stocked stay hidden, not 86d');
  w.eval('S.bottles.find(b=>b.name==="Sipsmith").level="full"; renderMenu();'); await sleep(20);
  assert(d.querySelectorAll('#menu-body .mname.dead').length===0, 'restocking clears the 86 marks');

  assert(d.querySelectorAll('#view-menu button').length===5, 'admin menu chrome: curate + share + bartender + requests + exit');
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
  brow.querySelector('.ir-bottle').dispatchEvent(new w.Event('input',{bubbles:true})); await sleep(20);
  let sgItems = [...d.querySelectorAll('#modal .suggest .sg-item')].map(e=>e.textContent);
  assert(sgItems.length===w.eval('S.bottles.length') && sgItems[0]==='Amaro Nonino Quintessentia', 'bottle field pops sorted suggestions (custom, not datalist)');
  d.getElementById('rf-name').value = 'Bottle Test';
  brow.querySelector('.ir-qty').value = '2';
  brow.querySelector('.ir-bottle').value = 'nonexistent bottle';
  d.getElementById('rf-save').click(); await sleep(30);
  assert(!w.eval('S.recipes.some(r=>r.name==="Bottle Test")') && d.getElementById('modalwrap').classList.contains('on'), 'an unknown bottle name blocks the save with the form intact');
  brow.querySelector('.ir-bottle').value = 'campari';
  brow.querySelector('.ir-bottle').dispatchEvent(new w.Event('input',{bubbles:true})); await sleep(20);
  const sgHits = [...d.querySelectorAll('#modal .suggest .sg-item')];
  assert(sgHits.length===1 && sgHits[0].textContent==='Campari Bitter', 'typing filters the suggestions');
  sgHits[0].dispatchEvent(new w.Event('mousedown',{bubbles:true})); await sleep(20);
  assert(brow.querySelector('.ir-bottle').value==='Campari Bitter', 'tapping a suggestion fills the field');
  d.getElementById('rf-save').click(); await sleep(30);
  const bt = 'S.recipes.find(r=>r.name==="Bottle Test")';
  assert(w.eval(bt+'.ingredients[0].req.bottleId')===w.eval('S.bottles.find(b=>b.name==="Campari Bitter").id'), 'a typed name resolves to the bottle id, case-insensitively');
  assert(w.eval('recipeBase('+bt+')')==='amaro', 'a specific-bottle ingredient counts as its bottle category for the base');
  assert(w.eval('recipeBase({ingredients:[{req:{bottleId:S.bottles.find(b=>b.name==="Sipsmith").id}},{req:{staple:"lemon"}}]})')==='gin',
    'a bottle-specific gin makes the recipe a gin drink, not "other"');
  const resc = JSON.parse(w.eval('JSON.stringify(convertAiRecipe({name:"X",method:"build",ingredients:[' +
    '{kind:"staple",staple:"gin",qty:"1.5",unit:"oz"},' +
    '{kind:"tag",category:"other",subtype:"bourbon",qty:"2",unit:"oz"},' +
    '{kind:"staple",staple:"ginger",qty:"1",unit:"oz"}]}).ingredients)'));
  assert(resc[0].req.tag && resc[0].req.tag.category==='gin', 'AI spirits filed as staples get rescued into real categories');
  assert(resc[1].req.tag && resc[1].req.tag.category==='whiskey' && resc[1].req.tag.subtype==='bourbon', 'other/bourbon rescues to whiskey');
  assert(resc[2].req.staple==='ginger', 'ginger stays a staple — no false gin match');

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

  // --- wishlist with photos (lives on the Shelf tab) ---
  w.eval('setTab("shelf")');
  assert(d.querySelector('#view-shelf #wish-list')!==null && d.querySelector('#view-shelf #btn-addwish')!==null, 'the wishlist lives on the Shelf tab');
  d.getElementById('btn-addwish').click(); await sleep(20);
  d.getElementById('wf-name').value = 'Chartreuse V.E.P.';
  d.getElementById('wf-notes').value = 'saw it at the shop downtown';
  d.getElementById('wf-save').click(); await sleep(30);
  assert(w.eval('S.wishlist.length')===1 && w.eval('S.wishlist[0].notes').includes('downtown'), 'wishlist add saves name + notes');
  assert([...d.querySelectorAll('#wish-list .wname')].some(e=>e.textContent==='Chartreuse V.E.P.'), 'wish renders on Tonight');
  w.eval('S.wishlist[0].img="data:image/jpeg;base64,aGVsbG8="; save(); renderWishlist();'); await sleep(20);
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

  // --- quota safety: a photo either persists or visibly does not happen ---
  w.eval('window.__origSI = Storage.prototype.setItem; Storage.prototype.setItem = function(){ throw new Error("QuotaExceededError"); };');
  const wlBefore = w.eval('S.wishlist.length');
  assert(w.upsertWish({ name:'Huge Photo', img:'data:image/jpeg;base64,aGk=' })===null && w.eval('S.wishlist.length')===wlBefore,
    'an unsaveable photo reverts — nothing half-saved');
  assert(/fit in storage/.test(d.getElementById('toast').textContent), 'the quota toast explains what happened');
  assert(w.eval('storageFull')===true, 'the storageFull flag is set');
  w.eval('openSettings()'); await sleep(20);
  assert(/Storage is full/.test(d.getElementById('modal').textContent), 'Settings shows the persistent storage warning');
  w.eval('closeModal(); Storage.prototype.setItem = window.__origSI;');
  w.eval('saveNow()');
  assert(w.eval('storageFull')===false, 'the flag clears on the next successful write');

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

  // --- sync conflict tripwire: two devices, one code ---
  await sleep(350); // let the restore's debounced save land
  w.eval('clearTimeout(_pushT);');
  w.__syncPuts = 0;
  const conflictState = JSON.parse(w.eval('exportJSON()'));
  conflictState.menuTitle = 'Other Device Bar';
  conflictState.savedAt = Date.now() + 9e9;
  w.__syncStore[altCode] = JSON.stringify(conflictState);
  w.eval('_syncChecked=false; _syncBlocked=false;');
  await w.syncPush(); await sleep(30);
  assert(w.__syncPuts===0 && w.eval('_syncBlocked')===true, 'a newer remote copy blocks the push');
  assert(d.getElementById('sc-keep')!==null && d.getElementById('sc-restore')!==null, 'the conflict modal offers both ways out');
  await w.syncPush(); await sleep(30);
  assert(w.__syncPuts===0, 'pushes stay paused until the user picks a side');
  d.getElementById('sc-keep').click(); await sleep(60);
  assert(w.__syncPuts===1 && !d.getElementById('modalwrap').classList.contains('on'), 'keep-this-phone pushes once and closes the modal');
  assert(JSON.parse(w.__syncStore[altCode]).menuTitle===w.eval('S.menuTitle'), 'the cloud copy now matches this phone');

  // dismissing the conflict modal (backdrop / back gesture) must not strand cloud backup
  w.__syncPuts = 0;
  const conflict2 = JSON.parse(w.eval('exportJSON()'));
  conflict2.menuTitle = 'Device C Bar';
  conflict2.savedAt = Date.now() + 95e8;
  w.__syncStore[altCode] = JSON.stringify(conflict2);
  w.eval('clearTimeout(_pushT); _syncChecked=false; _syncBlocked=false;');
  await w.syncPush(); await sleep(30);
  assert(w.eval('_syncBlocked')===true && d.getElementById('sc-keep')!==null, 'a second conflict re-arms the tripwire');
  w.eval('closeModal()'); await sleep(20); // the reflex backdrop-tap dismissal
  assert(w.eval('_syncBlocked')===false && w.eval('_syncChecked')===false, 'dismissing without choosing re-arms instead of stranding backups');
  await w.syncPush(); await sleep(30);
  assert(d.getElementById('sc-keep')!==null && w.__syncPuts===0, 'the next push re-prompts the choice, still without overwriting');
  d.getElementById('sc-keep').click(); await sleep(60);
  assert(w.__syncPuts===1, 'and choosing keep finally pushes');

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
  w.eval('sharedMenu=null; sharedMenuId=null; if(_guestT){clearInterval(_guestT); _guestT=null;} renderMenu();'); await sleep(120);
  assert(!d.getElementById('menu-reqs').classList.contains('hidden'), 'the host sees the request bell in admin menu mode');
  assert(d.getElementById('menu-reqs').textContent.includes('1'), 'the bell shows the request count');
  assert(w.eval('S.menuId')==='abc123', 'the bell polls the stable S.menuId');
  await w.openRequestInbox(); await sleep(60);
  assert(d.getElementById('modal').textContent.includes('Negroni') && d.getElementById('modal').textContent.includes('Maria'), 'the inbox lists who wants what');
  assert(w.__lastReqAuth==='Bearer ' + 'a'.repeat(32), 'inbox reads carry the owner token');
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

  // --- back gesture closes an open modal, not the page ---
  w.eval('openModal("<h2>history test</h2>")'); await sleep(10);
  assert(d.getElementById('modalwrap').classList.contains('on'), 'modal opens (and pushes a history entry)');
  w.eval('window.dispatchEvent(new PopStateEvent("popstate"))'); await sleep(10);
  assert(!d.getElementById('modalwrap').classList.contains('on'), 'popstate closes the modal instead of leaving the page');

  // ================= BAR-SPEC-1.2: same data, same verbs, different paint =================
  // --- toggle infrastructure ---
  assert(w.eval('S.shelfView')==='list' && w.eval('S.specsView')==='list' && w.eval('S.nerdMode')===false, '1.2 view fields default to list / list / nerd off');
  assert(w.eval('fresh().shelfView')==='list' && w.eval('fresh().specsView')==='list' && w.eval('fresh().nerdMode')===false, 'fresh state carries the 1.2 defaults');
  w.eval('S.shelfView="bar"; S.specsView="sky"; S.nerdMode=true; saveNow();');
  assert(w.eval('load().shelfView')==='bar' && w.eval('load().specsView')==='sky' && w.eval('load().nerdMode')===true, 'flipped toggles survive a reload');
  const preView = JSON.parse(w.eval('exportJSON()'));
  delete preView.shelfView; delete preView.specsView; delete preView.nerdMode;
  assert(w.eval('importJSON('+JSON.stringify(JSON.stringify(preView))+')')===null, 'a pre-1.2 backup still imports');
  assert(w.eval('S.shelfView')==='list' && w.eval('S.specsView')==='list' && w.eval('S.nerdMode')===false, 'missing view fields default cleanly on import');
  const preFlavor = JSON.parse(w.eval('exportJSON()'));
  delete preFlavor.recipes.find(r=>r.id==='r23').flavor;                       // a pre-1.2 classic
  preFlavor.recipes.find(r=>r.id==='r24').flavor = { x:0.9, y:0.9 };           // a user-moved one
  assert(w.eval('importJSON('+JSON.stringify(JSON.stringify(preFlavor))+')')===null, 'a backup with flavorless classics imports');
  assert(JSON.parse(w.eval('JSON.stringify(S.recipes.find(r=>r.id==="r23").flavor)')).x===0.12, 'an unplaced classic gets its baked coordinates back');
  assert(JSON.parse(w.eval('JSON.stringify(S.recipes.find(r=>r.id==="r24").flavor)')).x===0.9, 'a recipe that already has coordinates is never touched');
  w.eval('openRecipeForm("r24")'); await sleep(20);
  d.getElementById('rf-save').click(); await sleep(30);
  assert(JSON.parse(w.eval('JSON.stringify(S.recipes.find(r=>r.id==="r24").flavor)')).x===0.9, 'editing a recipe through the form keeps its flavor coordinates');

  // --- the shelf becomes a shelf ---
  w.eval('setTab("shelf")');
  d.getElementById('btn-shelfview').click(); await sleep(30);
  assert(w.eval('S.shelfView')==='bar', 'the toggle next to search flips the shelf to bar view');
  const stockedCats = JSON.parse(w.eval('JSON.stringify(Array.from(new Set(S.bottles.map(b=>b.category))))'));
  assert(d.querySelectorAll('#shelf-list svg.barshelf').length===stockedCats.length, 'one shelf svg per stocked category, empty categories skipped');
  assert(d.querySelectorAll('#shelf-list .bar-bottle').length===w.eval('S.bottles.length'), 'every bottle stands on a shelf');
  const fullId = w.eval('S.bottles.find(b=>b.level==="full").id');
  const fullName = w.eval('S.bottles.find(b=>b.id==="'+fullId+'").name');
  const fullCat = w.eval('S.bottles.find(b=>b.id==="'+fullId+'").category');
  let bg = d.querySelector('.bar-bottle[data-id="'+fullId+'"]');
  let liq = bg.querySelector('.bar-liquid');
  const expFull = JSON.parse(w.eval('JSON.stringify(liquidRect("'+fullCat+'","full"))'));
  assert(Math.abs(+liq.getAttribute('height')-expFull.h)<0.01 && Math.abs(+liq.getAttribute('y')-expFull.y)<0.01, 'a full bottle\'s liquid fills ~85% of its glass');
  assert(bg.querySelector('.lblband')!==null, 'no photo yet: the brass name band fills the label zone');
  bg.dispatchEvent(new w.Event('click',{bubbles:true})); await sleep(30);
  assert(w.eval('S.bottles.find(b=>b.id==="'+fullId+'").level')==='low', 'tapping a silhouette calls through to cycleLevel');
  bg = d.querySelector('.bar-bottle[data-id="'+fullId+'"]');
  liq = bg.querySelector('.bar-liquid');
  const expLow = JSON.parse(w.eval('JSON.stringify(liquidRect("'+fullCat+'","low"))'));
  assert(Math.abs(+liq.getAttribute('height')-expLow.h)<0.01 && (liq.getAttribute('class')||'').includes('low'), 'the re-render drops the liquid to the low mark');
  bg.querySelector('.bar-edit').dispatchEvent(new w.Event('click',{bubbles:true})); await sleep(30);
  assert(d.getElementById('modalwrap').classList.contains('on') && d.getElementById('bf-name').value===fullName, 'the ✎ dot opens the bottle form, not a level cycle');
  w.eval('closeModal()'); await sleep(10);
  w.eval('S.bottles.find(b=>b.id==="'+fullId+'").level="out"; renderShelf();'); await sleep(20);
  bg = d.querySelector('.bar-bottle[data-id="'+fullId+'"]');
  assert((bg.getAttribute('class')||'').includes('out') && +bg.querySelector('.bar-liquid').getAttribute('height')===0, 'an out bottle ghosts: no liquid, struck styling');
  w.eval('S.bottles.find(b=>b.id==="'+fullId+'").level="full"; save(); renderShelf();'); await sleep(20);
  d.getElementById('shelf-search').value='eagle';
  d.getElementById('shelf-search').dispatchEvent(new w.Event('input')); await sleep(20);
  assert(d.querySelectorAll('#shelf-list .bar-bottle').length===1, 'the search field still filters the bar view');
  d.getElementById('shelf-search').value='';
  d.getElementById('shelf-search').dispatchEvent(new w.Event('input')); await sleep(20);

  // --- label thumbnails from the AI scan ---
  w.eval('window.__realCropThumb = cropThumb; cropThumb = async () => "data:image/jpeg;base64,dGh1bWI=";');
  w.__scanResult = { bottles: [
    { name:'Boxed Gin Bottle', category:'gin', box:{ x:0.1, y:0.2, w:0.15, h:0.5 } },
    { name:'Plain Rum Bottle', category:'rum' },
    { name:'Bad Box Bottle', category:'vodka', box:{ x:2, y:0, w:9, h:9 } },
  ]};
  const scanned2 = await w.requestScan('image/jpeg','aGVsbG8=');
  w.openConfirmSheet(scanned2, 'data:image/jpeg;base64,cGhvdG8='); await sleep(50);
  assert(d.querySelectorAll('#modal img.scanthumb').length===1, 'the confirm sheet shows a crop beside the boxed row only');
  assert([...d.querySelectorAll('#modal .scanrow')].filter(r=>r.querySelector('.scanthumb')).length===1, 'a bad box is rejected — no thumbnail machinery for that row');
  d.getElementById('sr-commit').click(); await sleep(30);
  assert(String(w.eval('(S.bottles.find(b=>b.name==="Boxed Gin Bottle")||{}).thumb||""')).startsWith('data:image'), 'a committed row stores its crop as bottle.thumb');
  assert(w.eval('S.bottles.find(b=>b.name==="Plain Rum Bottle").thumb')===undefined, 'no box, no thumb — the field never blocks');
  w.eval('renderShelf()'); await sleep(20);
  const boxedId = w.eval('S.bottles.find(b=>b.name==="Boxed Gin Bottle").id');
  assert(d.querySelector('.bar-bottle[data-id="'+boxedId+'"] image.bar-thumb')!==null, 'the bar view clips the crop into the label zone');
  w.eval('openBottleForm("'+boxedId+'")'); await sleep(20);
  d.getElementById('bf-save').click(); await sleep(20);
  assert(String(w.eval('(S.bottles.find(b=>b.id==="'+boxedId+'")||{}).thumb||""')).startsWith('data:image'), 'an ordinary edit keeps the photo label');
  w.eval('openBottleForm("'+boxedId+'")'); await sleep(20);
  assert(d.getElementById('bf-thumbdel')!==null, 'the edit form offers Remove photo label');
  d.getElementById('bf-thumbdel').click(); await sleep(10);
  d.getElementById('bf-save').click(); await sleep(20);
  assert(w.eval('S.bottles.find(b=>b.id==="'+boxedId+'").thumb')===undefined, 'removing the photo label really removes it');
  w.eval('renderShelf()'); await sleep(20);
  assert(d.querySelector('.bar-bottle[data-id="'+boxedId+'"] .lblband')!==null, 'and the brass band returns');
  w.eval('S.bottles.find(b=>b.id==="'+boxedId+'").thumb="data:image/jpeg;base64,dGh1bWI="; saveNow();');
  const thumbBackup = w.eval('exportJSON()');
  w.eval('localStorage.clear(); S=fresh(); renderAll();');
  assert(w.eval('importJSON('+JSON.stringify(thumbBackup)+')')===null, 'a backup with thumbs imports');
  assert(String(w.eval('(S.bottles.find(b=>b.name==="Boxed Gin Bottle")||{}).thumb||""')).startsWith('data:image'), 'thumb survives export → wipe → import');
  w.eval('cropThumb = window.__realCropThumb;');
  w.eval('deleteBottle(S.bottles.find(b=>b.name==="Boxed Gin Bottle").id)'); await sleep(20);
  w.eval('deleteBottle(S.bottles.find(b=>b.name==="Plain Rum Bottle").id)'); await sleep(20);
  w.eval('deleteBottle(S.bottles.find(b=>b.name==="Bad Box Bottle").id)'); await sleep(20);
  d.getElementById('btn-shelfview').click(); await sleep(20);
  assert(w.eval('S.shelfView')==='list' && d.querySelector('#shelf-list .bottle')!==null, 'toggling back restores the list view untouched');

  // --- the flavor galaxy ---
  w.eval('setTab("specs")');
  d.getElementById('btn-specsview').click(); await sleep(30);
  assert(w.eval('S.specsView')==='sky' && d.querySelector('#spec-list svg#galaxy')!==null, 'the specs toggle turns the list into a star field');
  assert(d.querySelectorAll('#galaxy .star').length===w.eval('S.recipes.length'), 'every recipe is a star');
  const negXY = JSON.parse(w.eval('JSON.stringify(starXY(S.recipes.find(r=>r.id==="r23")))'));
  const negStar = d.querySelector('#galaxy .star[data-id="r23"]');
  assert(negStar.getAttribute('transform')==='translate('+negXY.x+' '+negXY.y+')', 'seeded classics render at their baked coordinates');
  const corner = ['r07','r23','r33'].map(id=>JSON.parse(w.eval('JSON.stringify(flavorPos(S.recipes.find(r=>r.id==="'+id+'")))')));
  assert(corner.every(p=>p.x<0.3 && p.y<0.3), 'Negroni, Boulevardier, Black Manhattan hold the bitter-boozy corner');
  const tiki = ['r17','r19','r20'].map(id=>JSON.parse(w.eval('JSON.stringify(flavorPos(S.recipes.find(r=>r.id==="'+id+'")))')));
  assert(tiki.every(p=>p.y>0.6) && tiki[1].x<tiki[0].x && tiki[1].x<tiki[2].x, 'the tiki nebula floats bright-refreshing, Jungle Bird pulled bitterward');
  w.upsertRecipe({ name:'Nova Test', method:'shake', glass:'coupe', garnish:'', notes:'', rating:0, house:false,
    ingredients:[ { qty:'2', unit:'oz', req:{ tag:{ category:'gin' } } }, { qty:'0.75', unit:'oz', req:{ staple:'lime' } }, { qty:'3', unit:'oz', req:{ tag:{ category:'mixer', subtype:'soda water' } } } ] });
  await sleep(20);
  const nova = 'S.recipes.find(r=>r.name==="Nova Test")';
  const f1 = w.eval('JSON.stringify(flavorOf('+nova+'))');
  assert(f1===w.eval('JSON.stringify(flavorOf('+nova+'))'), 'flavorOf is deterministic — same recipe, same spot');
  const fpos = JSON.parse(f1);
  assert(fpos.x>0.5 && fpos.y>0.6 && fpos.x<=0.96 && fpos.y<=0.96, 'citrus pushes bright, soda pushes refreshing, clamped inside the frame');
  assert(d.querySelector('#galaxy .star[data-id="'+w.eval(nova+'.id')+'"]')!==null, 'a recipe without baked flavor still lands on the field');
  assert(/\b(mk|lw)\b/.test(negStar.getAttribute('class')||''), 'Negroni is lit while its bottles are stocked');
  w.eval('S.bottles.find(b=>b.name==="Campari Bitter").level="out"; save(); renderSpecs();'); await sleep(20);
  const affected = ['r23','r07','r19'].map(id=>d.querySelector('#galaxy .star[data-id="'+id+'"]'));
  assert(affected.every(s=>(s.getAttribute('class')||'').includes('dim')), 'cycling the Campari out dims Negroni, Boulevardier, and Jungle Bird in one render');
  affected[0].dispatchEvent(new w.Event('click',{bubbles:true})); await sleep(20);
  assert(d.getElementById('modalwrap').classList.contains('on') && d.getElementById('modal').textContent.includes('Negroni'), 'tapping a star opens the same recipe detail');
  w.eval('closeModal()'); await sleep(10);
  const mkChip2 = [...d.querySelectorAll('#spec-filters .chip')].find(c=>c.dataset.f==='__mk');
  mkChip2.click(); await sleep(20);
  assert(d.querySelectorAll('#galaxy .star').length>0 && [...d.querySelectorAll('#galaxy .star')].every(s=>!(s.getAttribute('class')||'').includes('dim')), 'the makeable-only chip hides the dim stars');
  mkChip2.click(); await sleep(20);
  d.getElementById('spec-search').value='campari';
  d.getElementById('spec-search').dispatchEvent(new w.Event('input')); await sleep(20);
  const negSpot = d.querySelector('#galaxy .star[data-id="r23"]');
  const martiniSpot = d.querySelector('#galaxy .star[data-id="r24"]');
  assert(!(negSpot.getAttribute('class')||'').includes('faded') && (martiniSpot.getAttribute('class')||'').includes('faded'), 'a search keeps hits lit and fades the rest — a spotlight, not a filter');
  d.getElementById('spec-search').value='';
  d.getElementById('spec-search').dispatchEvent(new w.Event('input')); await sleep(20);
  w.eval('S.bottles.find(b=>b.name==="Campari Bitter").level="low"; save(); renderSpecs();'); await sleep(20);
  // label declutter: recompute every placed label's box, assert zero overlaps
  const lblBoxes = [...d.querySelectorAll('#galaxy .star')].map(g => {
    const lbl = g.querySelector('.slabel');
    if(!lbl) return null;
    const t = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(g.getAttribute('transform'));
    const X = +t[1] + +lbl.getAttribute('x'), Y = +t[2] + +lbl.getAttribute('y');
    const wl = lbl.textContent.length*5.6 + 6;
    const anchor = lbl.getAttribute('text-anchor') || 'start';
    const x0 = anchor==='start' ? X : anchor==='end' ? X-wl : X-wl/2;
    return { x0, y0: Y-9-3.5, x1: x0+wl, y1: Y-9-3.5+11 };
  }).filter(Boolean);
  let lblHits = 0;
  for(let i=0;i<lblBoxes.length;i++) for(let j=i+1;j<lblBoxes.length;j++){
    const a=lblBoxes[i], b=lblBoxes[j];
    if(a.x0<b.x1 && b.x0<a.x1 && a.y0<b.y1 && b.y0<a.y1) lblHits++;
  }
  assert(lblBoxes.length>3 && lblHits===0, 'star labels never pile onto each other ('+lblBoxes.length+' placed, 0 overlaps)');
  const litCenters = [...d.querySelectorAll('#galaxy .star')].filter(g=>/\b(mk|lw|house)\b/.test(g.getAttribute('class')||'')).map(g=>{
    const t = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(g.getAttribute('transform'));
    return { x:+t[1], y:+t[2] };
  });
  assert(!litCenters.some(cn=>lblBoxes.some(b=>cn.x>b.x0&&cn.x<b.x1&&cn.y>b.y0&&cn.y<b.y1)), 'no lit star sits on top of a label');
  assert([...d.querySelectorAll('#galaxy .star.house')].every(g=>g.querySelector('.slabel')!==null), 'house drinks always keep their label');
  const sky1 = d.getElementById('spec-list').innerHTML;
  w.eval('renderSpecs()'); await sleep(20);
  assert(d.getElementById('spec-list').innerHTML===sky1, 'the sky renders identically twice — label layout is deterministic');
  w.eval('deleteRecipe('+nova+'.id)'); await sleep(20);
  d.getElementById('btn-specsview').click(); await sleep(20);
  assert(w.eval('S.specsView')==='list' && d.querySelector('#spec-list .rcard')!==null, 'toggling back restores the recipe cards');

  // --- liquid intelligence: the model ---
  const dq = 'S.recipes.find(r=>r.id==="r15")'; // the seeded Daiquiri
  const stats = JSON.parse(w.eval('JSON.stringify(drinkStats('+dq+'))'));
  assert(Math.abs(stats.volOz-3.75)<1e-9, 'drinkStats: the Daiquiri is 3.75 oz as written');
  assert(Math.abs(stats.abv-(2*0.40)/3.75)<1e-9, 'drinkStats: rum is the only alcohol — ~21% ABV in the glass');
  const shakeCurve = JSON.parse(w.eval('JSON.stringify(chillCurve('+dq+',"shake",40))'));
  const stirCurve = JSON.parse(w.eval('JSON.stringify(chillCurve('+dq+',"stir",180))'));
  assert(shakeCurve.length===41 && stirCurve.length===181, 'chillCurve samples once per second');
  const monoT = c=>c.every((p,i)=>i===0||p.temp<=c[i-1].temp+1e-9);
  const monoD = c=>c.every((p,i)=>i===0||p.dilutionPct>=c[i-1].dilutionPct-1e-9);
  assert(monoT(shakeCurve)&&monoT(stirCurve), 'temperature only ever falls');
  assert(monoD(shakeCurve)&&monoD(stirCurve), 'dilution only ever rises');
  const balanced = c=>c.every(p=>{
    const mw = stats.massG*3.8*(20-p.temp)/(334+4.18*p.temp);
    return Math.abs(p.dilutionPct-(mw/stats.massG*100))<1e-6;
  });
  assert(balanced(shakeCurve)&&balanced(stirCurve), 'every sample satisfies m_w = m_d·c_d·(T0−T)/(L_f+c_w·T) — temp and dilution never move independently');
  const reach = (c,T)=>{ const p=c.find(x=>x.temp<=T); return p?p.t:Infinity; };
  assert(reach(shakeCurve,-5)<reach(stirCurve,-5), 'a shake reaches −5°C faster than a stir ever will');
  assert(shakeCurve[40].abv<stats.abv, 'melt water lowers the ABV as the drink chills');

  // --- liquid intelligence: the sheet ---
  w.eval('S.nerdMode=false; save(); openRecipeDetail("r15")'); await sleep(20);
  assert(d.getElementById('li-sec')===null, 'nerd mode off: the detail sheet is exactly yesterday\'s');
  w.eval('closeModal(); S.nerdMode=true; save(); openRecipeDetail("r15")'); await sleep(20);
  assert(d.getElementById('li-sec')!==null && d.getElementById('li-body').classList.contains('hidden'), 'nerd mode on: the section is there, collapsed by default');
  d.getElementById('li-toggle').click(); await sleep(20);
  assert(!d.getElementById('li-body').classList.contains('hidden'), 'tapping the header expands it');
  assert(d.querySelector('#li-chart .li-temp')!==null && d.querySelector('#li-chart .li-dil')!==null, 'the chart draws temperature and dilution together');
  assert(d.querySelector('#li-chart .li-ghost')!==null, 'the other method\'s curve is ghosted behind');
  assert(/Shake about \d+ seconds: −?[\d.]+°C, \d+% dilution, lands at \d+% ABV\./.test(d.getElementById('li-verdict').textContent), 'the verdict line is recomputed from the model');
  assert(/\d+ s — /.test(d.getElementById('li-read').textContent), 'the scrub readout starts at the serve point');
  w.eval('closeModal(); openRecipeDetail("r09")'); await sleep(20); // Highball = build
  assert(d.getElementById('li-sec')===null, 'build recipes get no physics section');
  w.eval('closeModal()');
  w.upsertRecipe({ name:'Zero Vol', method:'stir', glass:'rocks', garnish:'', notes:'', rating:0, house:false,
    ingredients:[ { qty:'1', unit:'rinse', req:{ tag:{ category:'liqueur', subtype:'absinthe' } } }, { qty:'8', unit:'leaf', req:{ staple:'mint' } } ] });
  w.eval('openRecipeDetail(S.recipes.find(r=>r.name==="Zero Vol").id)'); await sleep(20);
  assert(d.getElementById('li-sec')===null, 'no parseable volume: the section hides rather than showing nonsense');
  w.eval('closeModal(); deleteRecipe(S.recipes.find(r=>r.name==="Zero Vol").id);'); await sleep(20);
  w.eval('openSettings()'); await sleep(20);
  assert(d.getElementById('st-nerd')!==null && d.getElementById('st-nerd').checked===true, 'Settings exposes the Liquid Intelligence switch');
  d.getElementById('st-nerd').checked=false;
  d.getElementById('st-nerd').dispatchEvent(new w.Event('change')); await sleep(20);
  assert(w.eval('S.nerdMode')===false, 'flipping the switch persists');
  w.eval('closeModal(); setTab("shelf");');

  // ================= BAR-SPEC-1.3: the atmosphere release =================
  // --- state defaults ---
  assert(w.eval('S.menuTheme')==='golden' && w.eval('S.geo')===null && w.eval('S.geoAsked')===false, '1.3 fields default to golden / no location');
  assert(w.eval('fresh().menuTheme')==='golden' && w.eval('fresh().geo')===null, 'fresh state carries the 1.3 defaults');

  // --- the drink render: color is computed, never picked ---
  const cNeg = JSON.parse(w.eval('JSON.stringify(colorOf(S.recipes.find(r=>r.id==="r23")))'));
  assert(w.eval('JSON.stringify(colorOf(S.recipes.find(r=>r.id==="r23")))')===JSON.stringify(cNeg), 'colorOf is deterministic');
  const cDaiq = JSON.parse(w.eval('JSON.stringify(colorOf(S.recipes.find(r=>r.id==="r15")))'));
  assert(cNeg.r-cNeg.g>60 && cNeg.r>120, 'Negroni lands ruby');
  assert(cDaiq.r>200 && cDaiq.g>190 && (cDaiq.r-cDaiq.g)<40, 'Daiquiri lands pale straw');
  const cPP = JSON.parse(w.eval('JSON.stringify(colorOf(S.recipes.find(r=>r.id==="r06")))'));
  assert(cPP.r>150 && cPP.g>90 && cPP.g<160 && cPP.b<100, 'Paper Plane lands sunset orange');
  const cEM = JSON.parse(w.eval('JSON.stringify(colorOf(S.recipes.find(r=>r.id==="r31")))'));
  assert(cEM.r<80 && cEM.g<80 && cEM.foam===true, 'Espresso Martini lands near-black with a head hint');
  assert(w.eval('colorOf(S.recipes.find(r=>r.id==="r03")).foam')===true, 'a zero-volume egg white still raises the head');
  w.eval('openRecipeDetail("r03")'); await sleep(20);
  assert(d.querySelector('#modal .dr-foam')!==null, 'the Whiskey Sour wears its foam band');
  w.eval('closeModal()');
  const cPC = JSON.parse(w.eval('JSON.stringify(colorOf(S.recipes.find(r=>r.id==="r20")))'));
  const cMart = JSON.parse(w.eval('JSON.stringify(colorOf(S.recipes.find(r=>r.id==="r24")))'));
  assert(cPC.opacity>=0.9 && cMart.opacity<=0.65, 'Piña Colada opaque above the threshold, Martini translucent below');
  // glass keyword mapping
  assert(w.eval('glassFor("coupe").key')==='coupe' && w.eval('glassFor("Nick & Nora coupe").key')==='coupe', 'coupe keyword maps');
  assert(w.eval('glassFor("double old fashioned").key')==='rocks' && w.eval('glassFor("tiki mug").key')==='rocks', 'rocks fallback catches the rest');
  assert(w.eval('glassFor("collins").key')==='highball' && w.eval('glassFor("highball").key')==='highball', 'collins and highball share a glass');
  assert(w.eval('glassFor("flute").key')==='flute' && w.eval('glassFor("wine glass").key')==='wine' && w.eval('glassFor("hurricane").key')==='hurricane' && w.eval('glassFor("martini").key')==='martini', 'the rest of the set maps by keyword');
  // build drinks layer by specific gravity
  w.eval('openRecipeDetail("r18")'); await sleep(20); // Dark 'n Stormy
  assert(d.querySelector('#modal svg.drinkrender')!==null, 'the recipe detail carries the render');
  const bandSGs = [...d.querySelectorAll('#modal .dr-band')].map(e=>+e.getAttribute('data-sg'));
  assert(bandSGs.length>=2 && bandSGs.every((v,i)=>i===0||v<=bandSGs[i-1]), 'build bands stack heavy at the bottom, ordered by sgOf');
  assert(d.querySelector('#modal .dr-float')!==null, 'the dark rum float rides as a distinct top band');
  assert(/float holds/.test(d.getElementById('modal').textContent), "Dark 'n Stormy: the float holds");
  w.eval('closeModal(); openRecipeDetail("r22")'); await sleep(20); // Corn 'n Oil
  assert(/float holds/.test(d.getElementById('modal').textContent), "Corn 'n Oil: the canonical hold");
  w.eval('closeModal()');
  w.upsertRecipe({ name:'Sinker', method:'build', glass:'rocks', garnish:'', notes:'', rating:0, house:false,
    ingredients:[ { qty:'2', unit:'oz', req:{ tag:{ category:'whiskey' } } }, { qty:'0.5', unit:'oz', req:{ tag:{ category:'liqueur', subtype:'coffee' } }, note:'float' } ] });
  assert(w.eval('floatVerdict(S.recipes.find(r=>r.name==="Sinker")).holds')===false, 'a heavy liqueur floated on neat spirit sinks');
  w.eval('openRecipeDetail(S.recipes.find(r=>r.name==="Sinker").id)'); await sleep(20);
  assert(/sinks and marbles/.test(d.getElementById('modal').textContent), 'the sink verdict renders');
  assert(d.querySelector('#modal .dr-float')===null, 'a sinking float gets no top band — it marbles into the body');
  w.eval('closeModal()');
  // SG detail readout rides behind nerd mode; the verdict does not
  w.eval('S.nerdMode=true; save(); openRecipeDetail("r22")'); await sleep(20);
  assert(/sg \d\.\d{3}/.test(d.getElementById('modal').textContent), 'nerd mode surfaces per-ingredient SG');
  w.eval('closeModal(); S.nerdMode=false; save(); openRecipeDetail("r22")'); await sleep(20);
  assert(!/sg \d\.\d{3}/.test(d.getElementById('modal').textContent) && /float holds/.test(d.getElementById('modal').textContent),
    'nerd mode off: no SG numbers, verdict still visible');
  w.eval('closeModal(); deleteRecipe(S.recipes.find(r=>r.name==="Sinker").id);'); await sleep(20);
  // payload guard: nothing from the render leaks into shared menus
  const pkeys = Object.keys(JSON.parse(w.eval('JSON.stringify(menuPayload())')));
  assert(pkeys.every(k=>['t','c','s','f','b','th','su'].includes(k)), 'payload carries only menu fields (+theme/sunset)');
  assert(JSON.parse(w.eval('JSON.stringify(menuPayload())')).c.every(x=>Object.keys(x).every(k=>['n','d','h','x'].includes(k))), 'no render data on any menu item');

  // --- the weather-aware bartender ---
  w.eval('setTab("tonight")'); await sleep(30);
  assert(d.getElementById('wx-line').classList.contains('hidden'), 'no location: no ambient line');
  w.__bartenderBodies = [];
  w.__bartenderResult = { picks: [{ name:'Gimlet', why:'crisp and cold.' }] };
  d.getElementById('bt-mood').value = '';
  d.getElementById('bt-ask').click(); await sleep(100);
  const bNoGeo = JSON.parse(w.__bartenderBodies[0]);
  assert(Object.keys(bNoGeo).join()==='mood,drinks', 'no location: the bartender request is byte-identical to before');
  w.eval('closeModal()');
  Object.defineProperty(w.navigator, 'geolocation', { configurable:true,
    value:{ getCurrentPosition: (ok) => ok({ coords:{ latitude:29.4241, longitude:-98.4936 } }) } });
  const sunsetMs = Math.floor((Date.now()-3600e3)/1000)*1000; // an hour past sunset
  w.__wxResult = { current:{ temperature_2m:94.2, relative_humidity_2m:74, weather_code:1 }, daily:{ sunset:[ sunsetMs/1000 ] } };
  d.getElementById('bt-ask').click(); await sleep(30);
  assert(d.getElementById('geo-yes')!==null && w.eval('S.geoAsked')===true, 'first bartender use asks once, with an explanation');
  d.getElementById('geo-yes').click(); await sleep(150);
  assert(w.eval('S.geo.lat')===29.42 && w.eval('S.geo.lon')===-98.49, 'granted location rounds to 2 decimals (~1km) before storing');
  const bGeo = JSON.parse(w.__bartenderBodies[1]);
  assert(bGeo.weather && bGeo.weather.temp===94 && bGeo.weather.humidity===74 && bGeo.weather.condition==='fair' && bGeo.weather.isEvening===true,
    'granted: weather rides along, evening detected past sunset');
  w.eval('closeModal(); setTab("tonight");'); await sleep(60);
  assert(!d.getElementById('wx-line').classList.contains('hidden') && /94° and humid/.test(d.getElementById('wx-line').textContent),
    'the ambient line reads like a bartender glancing outside');
  w.eval('_wx={at:0,data:null}'); w.__wxFail = true;
  d.getElementById('bt-ask').click(); await sleep(100);
  const bFail = JSON.parse(w.__bartenderBodies[2]);
  assert(Object.keys(bFail).join()==='mood,drinks', 'a dead weather fetch: request identical to today, no nagging');
  w.eval('closeModal()'); w.__wxFail = false;
  w.eval('openSettings()'); await sleep(20);
  assert(d.getElementById('st-geo-forget')!==null, 'Settings offers Forget my location');
  d.getElementById('st-geo-forget').click(); await sleep(30);
  assert(w.eval('S.geo')===null && w.eval('S.geoAsked')===false, 'forgetting nulls the location and re-arms the ask');
  w.eval('closeModal()');
  w.eval('setGeo(29.4241, -98.4936)'); // back on for the sundown tests

  // --- themes & sundown ---
  w.eval('setTab("menu")'); await sleep(30);
  assert(d.body.getAttribute('data-theme')==='golden', 'menu mode paints the default golden theme');
  w.eval('openMenuPicker()'); await sleep(20);
  const themeTab = [...d.querySelectorAll('#mp-tabs button')].find(b=>b.textContent==='Theme');
  themeTab.click(); await sleep(20);
  assert(d.querySelectorAll('#modal .thsw').length===8, 'the theme pane offers eight swatches');
  assert(d.querySelector('#modal .thsw[data-th="lagoon"]')!==null && w.eval('validTheme("lagoon")')==='lagoon', 'Lagoon is a first-class theme');
  assert(w.eval('validTheme("lune")')==='lune' && w.eval('validTheme("rosewood")')==='rosewood', 'Clair de Lune and Rosewood are first-class themes');
  d.querySelector('#modal .thsw[data-th="cassis"]').click(); await sleep(20);
  assert(w.eval('S.menuTheme')==='cassis' && d.body.getAttribute('data-theme')==='cassis', 'picking a swatch persists and repaints live');
  assert(d.querySelector('#modal .thsw[data-th="cassis"]').classList.contains('on'), 'the picked swatch is marked');
  w.eval('closeModal()');
  await w.fetchWeather(); // repopulate the cache so the payload can carry sunset
  const pTheme = JSON.parse(w.eval('JSON.stringify(menuPayload())'));
  assert(pTheme.th==='cassis' && pTheme.su===sunsetMs, 'payload round-trips theme + the host sunset epoch');
  // sundown: pure model first
  assert(w.eval('duskNow(100, 50)')===false && w.eval('duskNow(100, 150)')===true, 'duskNow flips at sunset');
  assert(w.eval('duskNow(100, 100 + 13*3600*1000)')===false, 'and clears before sunrise');
  assert(w.eval('duskNow(null, 150)')===false, 'no sunset known: dusk never engages');
  w.eval('updateDusk()'); await sleep(10);
  assert(d.body.hasAttribute('data-dusk'), 'past the host sunset, the room dims');
  w.eval('updateDusk('+(sunsetMs-60000)+')'); await sleep(10);
  assert(!d.body.hasAttribute('data-dusk'), 'before sunset, day variant');
  // guests: the host's theme, the host's sunset
  w.eval('setTab("shelf")'); await sleep(20);
  assert(d.body.getAttribute('data-theme')===null && !d.body.hasAttribute('data-dusk'), 'leaving menu mode clears the paint');
  w.eval('enterSharedMenu({ t:"X", c:[], s:[], th:"deco", su:'+(Date.now()-3600e3)+' })'); await sleep(30);
  assert(d.body.getAttribute('data-theme')==='deco' && d.body.hasAttribute('data-dusk'), 'a guest phone wears the host theme and dims at the host sunset');
  w.eval('sharedMenu.th="vaporwave"; renderMenu();'); await sleep(20);
  assert(d.body.getAttribute('data-theme')==='golden', 'an unknown theme key falls back to golden');
  w.eval('sharedMenu.su=Date.now()+3600e3; renderMenu();'); await sleep(20);
  assert(!d.body.hasAttribute('data-dusk'), 'before the host sunset, guests stay in the day variant');
  w.eval('delete sharedMenu.su; renderMenu();'); await sleep(20);
  assert(!d.body.hasAttribute('data-dusk'), 'no sunset in the payload: dusk never engages for guests');
  w.eval('sharedMenu=null; setTab("shelf");'); await sleep(20);
  // import: unknown theme falls back
  const themeBackup = JSON.parse(w.eval('exportJSON()'));
  themeBackup.menuTheme = 'vaporwave';
  assert(w.eval('importJSON('+JSON.stringify(JSON.stringify(themeBackup))+')')===null, 'a backup with a bogus theme imports');
  assert(w.eval('S.menuTheme')==='golden', 'and falls back to golden');

  // ================= sipping bottles: steer, never block =================
  w.eval('upsertBottle({name:"Pappy 15", category:"whiskey", subtype:"bourbon", level:"full", sip:true})');
  assert(w.eval('pourPick({tag:{category:"whiskey",subtype:"bourbon"}}).bottle.name')==='Eagle Rare', 'pour pick steers to the everyday bourbon');
  assert(w.eval('pourPick({tag:{category:"whiskey",subtype:"bourbon"}}).sipOnly')===false, 'not sip-only while an everyday bottle stands');
  w.eval('S.bottles.find(b=>b.name==="Eagle Rare").level="low"; save();');
  assert(w.eval('pourPick({tag:{category:"whiskey",subtype:"bourbon"}}).bottle.name')==='Eagle Rare', 'even a low everyday bottle beats the good stuff');
  w.eval('S.bottles.find(b=>b.name==="Eagle Rare").level="out"; save();');
  const sipPick = JSON.parse(w.eval('JSON.stringify(pourPick({tag:{category:"whiskey",subtype:"bourbon"}}))'));
  assert(sipPick.bottle.name==='Pappy 15' && sipPick.sipOnly===true, 'only the good bottle left: picked, and flagged honestly');
  assert(w.eval('recipeStatus(S.recipes.find(r=>r.id==="r03")).makeable')===true, 'a sipping bottle never blocks a drink');
  w.eval('openRecipeDetail("r03")'); await sleep(20); // Whiskey Sour, bourbon-gated
  assert(/only the good stuff matches/.test(d.getElementById('modal').textContent) && /Pappy 15/.test(d.getElementById('modal').textContent),
    'the detail says it straight when only the good bottle fits');
  w.eval('closeModal(); setTab("tonight");'); await sleep(20);
  const wsRow = [...d.querySelectorAll('#makeable-list .tonight-item')].find(el=>el.textContent.includes('Whiskey Sour'));
  assert(wsRow && wsRow.querySelector('.goodtag')!==null, 'Tonight quietly notes the good bottle');
  w.eval('S.bottles.find(b=>b.name==="Eagle Rare").level="full"; save(); renderAll();'); await sleep(20);
  w.eval('openRecipeDetail("r03")'); await sleep(20);
  assert(/pour the/.test(d.getElementById('modal').textContent) && /Eagle Rare/.test(d.getElementById('modal').textContent),
    'with the everyday bottle back, the line reads → pour the Eagle Rare');
  w.eval('closeModal(); setTab("tonight");'); await sleep(20);
  const wsRow2 = [...d.querySelectorAll('#makeable-list .tonight-item')].find(el=>el.textContent.includes('Whiskey Sour'));
  assert(wsRow2 && wsRow2.querySelector('.goodtag')===null, 'the tag clears when an everyday bottle covers it');
  // shelf marks, both views
  w.eval('setTab("shelf")'); await sleep(20);
  const pappyRow = [...d.querySelectorAll('#shelf-list .bottle')].find(el=>el.textContent.includes('Pappy 15'));
  assert(pappyRow && pappyRow.querySelector('.sipmark')!==null, 'the list row wears the ✦');
  d.getElementById('btn-shelfview').click(); await sleep(30);
  const pappyId = w.eval('S.bottles.find(b=>b.name==="Pappy 15").id');
  assert(d.querySelector('.bar-bottle[data-id="'+pappyId+'"] .bar-sip')!==null, 'so does the bar-view silhouette');
  d.getElementById('btn-shelfview').click(); await sleep(20);
  // the form toggle round-trips, and an ordinary edit preserves the flag
  w.eval('openBottleForm("'+pappyId+'")'); await sleep(20);
  assert(d.getElementById('bf-sip').checked===true, 'the edit form shows the flag');
  d.getElementById('bf-save').click(); await sleep(20);
  assert(w.eval('S.bottles.find(b=>b.name==="Pappy 15").sip')===true, 'an ordinary edit keeps it');
  w.eval('openBottleForm("'+pappyId+'")'); await sleep(20);
  d.getElementById('bf-sip').checked = false;
  d.getElementById('bf-save').click(); await sleep(20);
  assert(w.eval('S.bottles.find(b=>b.name==="Pappy 15").sip')===undefined, 'unticking clears it');
  w.eval('S.bottles.find(b=>b.name==="Pappy 15").sip=true; save();');
  // pour-list synergy: sipping bottles lead their category, starred in the picker
  w.eval('setTab("menu")'); await sleep(30);
  const whiskeyPours = JSON.parse(w.eval('JSON.stringify(menuPayload().s.filter(x=>x.c==="whiskey").map(x=>x.n))'));
  assert(whiskeyPours[0]==='Pappy 15', 'sipping bottles lead their category on the pour list');
  assert(JSON.parse(w.eval('JSON.stringify(menuPayload())')).s.every(x=>Object.keys(x).every(k=>['n','c','t'].includes(k))), 'the sip flag itself stays host-side');
  w.eval('openMenuPicker()'); await sleep(20);
  const pappyPk = [...d.querySelectorAll('#modal .mp-pk')].find(el=>el.closest('label').textContent.includes('Pappy 15'));
  assert(pappyPk && pappyPk.closest('label').querySelector('.sipmark')!==null, 'the picker stars the sipping bottle');
  w.eval('closeModal(); setTab("shelf");'); await sleep(20);
  // survives a backup round-trip
  const sipBackup = w.eval('exportJSON()');
  w.eval('localStorage.clear(); S=fresh(); renderAll();');
  assert(w.eval('importJSON('+JSON.stringify(sipBackup)+')')===null, 'backup with sip flags imports');
  assert(w.eval('S.bottles.find(b=>b.name==="Pappy 15").sip')===true, 'the flag survives export → wipe → import');
  w.eval('deleteBottle(S.bottles.find(b=>b.name==="Pappy 15").id)'); await sleep(20);

  // ================= close the bar, keep the link =================
  assert(w.eval('S.menuClosed')===false && w.eval('S.pushOn')===false, 'closed and push default off');
  assert(w.eval('fresh().menuClosed')===false && w.eval('fresh().pushOn')===false, 'fresh state carries the defaults');
  w.eval('setTab("menu")'); await sleep(30);
  w.eval('openMenuPicker()'); await sleep(20);
  const mpClosed = d.getElementById('mp-closed');
  assert(mpClosed!==null && mpClosed.checked===false, 'the curate sheet offers Close the bar');
  mpClosed.checked = true; mpClosed.dispatchEvent(new w.Event('change')); await sleep(30);
  assert(w.eval('S.menuClosed')===true && w.eval('menuPayload().cl')===true, 'closing persists and rides the payload');
  w.eval('closeModal()'); await sleep(10);
  assert(d.getElementById('menu-closedband')!==null, 'the host sees a quiet closed band, menu still editable');
  w.eval('setTab("shelf")'); await sleep(10);
  w.eval('enterSharedMenu({ t:"CJ Bar", c:[{n:"Negroni",d:"x",h:false}], s:[], th:"golden", cl:true })'); await sleep(30);
  assert(d.getElementById('menu-closed')!==null && d.querySelector('#menu-closed .cbig').textContent==='Closed' && /resting tonight/.test(d.getElementById('menu-body').textContent), 'guests get a real CLOSED sign, not the menu');
  assert(d.querySelectorAll('#menu-body .mitem').length===0, 'no drinks and no request taps while closed');
  w.eval('delete sharedMenu.cl; renderMenu();'); await sleep(20);
  assert(d.querySelectorAll('#menu-body .mitem').length===1, 'reopening brings the SAME link back to life');
  w.eval('sharedMenu=null; setTab("shelf"); S.menuClosed=false; save();'); await sleep(10);
  const clBackup = JSON.parse(w.eval('exportJSON()'));
  delete clBackup.menuClosed; delete clBackup.pushOn;
  assert(w.eval('importJSON('+JSON.stringify(JSON.stringify(clBackup))+')')===null, 'a pre-close backup imports');
  assert(w.eval('S.menuClosed')===false && w.eval('S.pushOn')===false, 'missing fields default off on import');

  // ================= drink-request push alerts =================
  w.eval('openSettings()'); await sleep(20);
  assert(/Add to Home Screen/.test(d.getElementById('modal').textContent), 'no push support: settings explains the install step');
  w.eval('closeModal()');
  w.eval('window.Notification = { permission:"default", requestPermission: async () => { window.Notification.permission = "granted"; return "granted"; } };' +
    'window.PushManager = function(){};' +
    'window.__fakeSub = { endpoint:"https://push.example/ep1", keys:{ p256dh:"pk", auth:"au" }, toJSON(){ return { endpoint:this.endpoint, keys:this.keys }; }, unsubscribe: async () => true };' +
    'window.__fakeReg = { pushManager: { getSubscription: async () => null, subscribe: async (o) => { window.__subOpts = o; return window.__fakeSub; } } };' +
    'Object.defineProperty(navigator, "serviceWorker", { configurable:true, value: { register: async () => window.__fakeReg, getRegistration: async () => window.__fakeReg } });');
  w.__pushPosts = [];
  await w.enablePush(); await sleep(60);
  assert(w.eval('S.pushOn')===true, 'enabling alerts flips the flag after permission');
  assert(w.__pushPosts.length>=1, 'the subscription registers with the worker');
  const pp = w.__pushPosts[w.__pushPosts.length-1];
  assert(pp.auth==='Bearer '+'a'.repeat(32) && JSON.parse(pp.body).endpoint==='https://push.example/ep1', 'registration is owner-gated and carries the endpoint');
  assert(/Turn off alerts/.test(d.getElementById('modal').textContent), 'settings shows alerts are on');
  w.eval('window.__fakeReg.pushManager.getSubscription = async () => window.__fakeSub;');
  await w.disablePush(); await sleep(40);
  assert(w.eval('S.pushOn')===false && w.__pushDeletes===1, 'turning off unsubscribes locally and at the worker');
  w.eval('closeModal()');
  // a worker identity change (new VAPID key) self-heals instead of wedging forever
  w.eval('S.pushOn = true; save(); window.__unsubs = 0;' +
    'window.__staleSub = { endpoint:"https://push.example/old", keys:{ p256dh:"pk", auth:"au" }, options:{ applicationServerKey: new Uint8Array([9,9,9]).buffer }, toJSON(){ return { endpoint:this.endpoint, keys:this.keys }; }, unsubscribe: async () => { window.__unsubs++; return true; } };' +
    'window.__fakeReg.pushManager.getSubscription = async () => window.__staleSub;');
  w.__pushPosts = [];
  const healed = await w.ensurePushSub(); await sleep(30);
  assert(healed===true && w.eval('window.__unsubs')===1, 'a stale VAPID binding is dropped, not re-posted');
  assert(w.__pushPosts.length===1 && JSON.parse(w.__pushPosts[0].body).endpoint==='https://push.example/ep1', 'and a fresh subscription takes its place');
  w.eval('S.pushOn = false; save();');

  // ================= retire a menu: a closed bar leaks nothing, a retired link dies =================
  w.eval('S.menuClosed=true; save();');
  const sharedBlank = JSON.parse(w.eval('JSON.stringify(sharePayload())'));
  assert(sharedBlank.cl===true && sharedBlank.c.length===0 && sharedBlank.s.length===0 && !sharedBlank.f && !sharedBlank.b,
    'a closed bar shares NO menu data — the sign is all anyone can read');
  const closedLink = w.eval('buildMenuLink()');
  const closedPayload = JSON.parse(w.eval('JSON.stringify(parseMenuHash('+JSON.stringify('#m=')+' + '+JSON.stringify(closedLink.split('#m=')[1])+'))'));
  assert(closedPayload.cl===true && closedPayload.c.length===0, 'the long link is equally blank while closed');
  w.eval('setTab("menu")'); await sleep(30);
  assert(d.getElementById('menu-closedband')!==null && d.querySelectorAll('#menu-body .mitem').length>0,
    'the HOST still sees the full menu while closed');
  w.eval('S.menuClosed=false; save();');
  w.eval('openMenuPicker()'); await sleep(20);
  assert(d.getElementById('mp-retire')!==null, 'the curate sheet offers Retire this link');
  const oldMenuId = w.eval('S.menuId');
  w.eval('S.menuClosed=true; save();'); // retire while closed: the next event must not inherit the closed sign
  w.__menuDeleted = ''; w.__menuPosts = 0;
  d.getElementById('mp-retire').click(); await sleep(150);
  assert(String(w.__menuDeleted).includes('/menu/'+oldMenuId), 'retiring revokes the old link at the worker — expired for old guests, for good');
  assert(w.eval('S.menuId')==='abc123' && w.__menuPosts===1, 'and a brand-new link is minted for the next event');
  assert(w.eval('S.menuClosed')===false, 'retiring reopens the bar — the fresh link never starts closed');
  w.eval('setTab("shelf")'); await sleep(10);
  // a guest refreshing a retired link dead-ends at an Expired sign, never the admin app
  w.__menuGetGone = true;
  await w.loadSharedMenu('deadbeef'); await sleep(30);
  assert(d.body.classList.contains('menuMode') && d.getElementById('menu-expired')!==null
    && d.querySelector('#menu-expired .cbig').textContent==='Expired', 'a retired link parks the guest at an Expired sign');
  assert(d.getElementById('menu-exit').classList.contains('hidden') && d.getElementById('menu-share').classList.contains('hidden')
    && d.getElementById('menu-curate').classList.contains('hidden'), 'the Expired sign carries zero admin chrome — no way into the app');
  assert(d.body.getAttribute('data-theme')==='golden', 'the sign wears the default theme');
  w.__menuGetGone = false;
  w.eval('sharedMenu=null; sharedMenuId=null; setTab("shelf");'); await sleep(10);

  // ================= the menu concierge =================
  w.eval('setTab("menu")'); await sleep(20);
  w.eval('openMenuPicker()'); await sleep(20);
  const closeLbl = d.getElementById('mp-closed').closest('label');
  assert(closeLbl.previousElementSibling && closeLbl.previousElementSibling.tagName==='HR', 'a rule now separates Close the bar — easier to find');
  assert(d.getElementById('mp-ai')!==null, 'the curate sheet offers the concierge');
  d.getElementById('mp-ai').click(); await sleep(20);
  assert(d.getElementById('cc-input')!==null && d.getElementById('cc-send')!==null, 'the concierge opens as a chat');
  w.__ccBodies = [];
  w.__ccResult = { reply:'A bright, easy spread for taco night — Gimlet up front.',
    menu:{ picks:['Gimlet','Margarita','Imaginary Fizz'], feature:'Gimlet', featureLabel:'taco night pour', theme:'lagoon' } };
  d.getElementById('cc-input').value = 'six friends, taco night';
  d.getElementById('cc-send').click(); await sleep(80);
  const ccReq = JSON.parse(w.__ccBodies[0]);
  const mkNames = JSON.parse(w.eval('JSON.stringify(makeableDrinkList().map(x=>x.name))'));
  assert(ccReq.drinks.length===mkNames.length && ccReq.drinks.every(x=>mkNames.includes(x.name)), 'the concierge only ever sees makeable drinks');
  assert(ccReq.history.length===1 && ccReq.history[0].role==='user' && /taco night/.test(ccReq.history[0].text), 'the event brief rides the history');
  assert(typeof ccReq.context.time==='string' && ccReq.context.time.length>0, 'the hour rides along');
  assert(/bright, easy spread/.test(d.getElementById('cc-log').textContent), 'the reply lands in the chat');
  assert(d.querySelector('#cc-log .cc-card')!==null && d.querySelector('#cc-log .cc-apply')!==null, 'a concrete proposal renders with a Set button');
  w.__ccResult = { reply:'Swapped for something lighter.', menu:{ picks:['Gimlet'], theme:'lagoon' } };
  d.getElementById('cc-input').value = 'less booze-forward please';
  d.getElementById('cc-send').click(); await sleep(80);
  assert(JSON.parse(w.__ccBodies[1]).history.length===3, 'feedback carries the whole conversation (user, assistant, user)');
  const applyBtns = [...d.querySelectorAll('#cc-log .cc-apply')];
  applyBtns[0].click(); await sleep(30); // apply the FIRST proposal — the one with unmakeable + imaginary picks
  const gimletId = w.eval('S.recipes.find(r=>r.name==="Gimlet").id');
  assert(w.eval('JSON.stringify(S.menuSelection)')===JSON.stringify([gimletId]), 'apply keeps only what the shelf can make — Margarita and the fake are dropped');
  assert(w.eval('S.featureId')===gimletId && w.eval('S.featureLabel')==='taco night pour', 'the feature and its label are written to the menu settings');
  assert(w.eval('S.menuTheme')==='lagoon' && d.body.getAttribute('data-theme')==='lagoon', 'the suggested theme applies live');
  assert(!d.getElementById('modalwrap').classList.contains('on'), 'the sheet closes — the menu behind it IS the result');
  const ccShown = [...d.querySelectorAll('#menu-body .mitem .mname')].map(e=>e.textContent);
  assert(ccShown.length===1 && ccShown[0].includes('Gimlet'), 'the live menu shows exactly the applied selection');
  w.eval('S.menuSelection=null; S.featureId=null; S.featureLabel="drink of the night"; S.menuTheme="golden"; save(); setTab("shelf");'); await sleep(10);
  w.eval('CFG.conciergeUrl=""; setTab("menu"); openMenuPicker();'); await sleep(20);
  assert(d.getElementById('mp-ai')===null, 'no relay configured: the concierge button vanishes');
  w.eval('closeModal(); CFG.conciergeUrl=CONCIERGE_URL; setTab("shelf");'); await sleep(10);

  // ================= specs: house-favorites filter =================
  w.eval('setTab("specs")'); await sleep(20);
  const houseChip = [...d.querySelectorAll('#spec-filters .chip')].find(c=>c.dataset.f==='__house');
  assert(!!houseChip && /House/.test(houseChip.textContent), 'the specs filters offer ★ House');
  houseChip.click(); await sleep(20);
  const houseNames = [...d.querySelectorAll('#spec-list .rname')].map(e=>e.textContent);
  const expectedHouse = JSON.parse(w.eval('JSON.stringify(S.recipes.filter(r=>r.house).map(r=>r.name))'));
  assert(houseNames.length===expectedHouse.length && expectedHouse.every(n=>houseNames.some(h=>h.includes(n))), 'the list shows exactly the house drinks');
  // it applies in the galaxy too
  d.getElementById('btn-specsview').click(); await sleep(30);
  assert(d.querySelectorAll('#galaxy .star').length===expectedHouse.length, 'the galaxy hides everything but the house stars');
  d.getElementById('btn-specsview').click(); await sleep(20);
  [...d.querySelectorAll('#spec-filters .chip')].find(c=>c.dataset.f==='__house').click(); await sleep(20);
  assert(d.querySelectorAll('#spec-list .rcard').length>expectedHouse.length, 'toggling off restores the full spec book');
  w.eval('setTab("shelf")'); await sleep(10);

  // ================= bartender mode: tap the menu, get the spec =================
  w.eval('setTab("menu")'); await sleep(30);
  assert(!d.getElementById('menu-tender').classList.contains('hidden'), 'the host sees the bartender toggle');
  let firstItem = d.querySelector('#menu-body .mitem[data-n]');
  firstItem.click(); await sleep(20);
  assert(!d.getElementById('modalwrap').classList.contains('on'), 'off by default: menu taps do nothing (safe to hand over)');
  d.getElementById('menu-tender').click(); await sleep(30);
  assert(d.getElementById('menu-tender').classList.contains('on'), 'the shaker lights up when bartender mode is on');
  firstItem = d.querySelector('#menu-body .mitem[data-n]');
  const tapName = firstItem.dataset.n;
  firstItem.click(); await sleep(30);
  assert(d.getElementById('modalwrap').classList.contains('on') && d.getElementById('rd-scale')!==null
    && d.querySelector('#modal h2').textContent.includes(tapName), 'tapping a drink opens its full spec');
  w.eval('closeModal()'); await sleep(10);
  d.getElementById('menu-tender').click(); await sleep(30);
  firstItem = d.querySelector('#menu-body .mitem[data-n]');
  firstItem.click(); await sleep(20);
  assert(!d.getElementById('modalwrap').classList.contains('on'), 'toggling off makes the menu inert again');
  // guests never see the toggle
  w.eval('enterSharedMenu({ t:"X", c:[{n:"Negroni",d:"x",h:false}], s:[], th:"golden" })'); await sleep(20);
  assert(d.getElementById('menu-tender').classList.contains('hidden'), 'guests never see bartender mode');
  w.eval('sharedMenu=null; setTab("shelf");'); await sleep(10);

  // ================= the build: derived step-by-step =================
  assert(w.eval('JSON.stringify(stepsFor(S.recipes.find(r=>r.id==="r15")))')===w.eval('JSON.stringify(stepsFor(S.recipes.find(r=>r.id==="r15")))'), 'steps are deterministic');
  const dqSteps = JSON.parse(w.eval('JSON.stringify(stepsFor(S.recipes.find(r=>r.id==="r15")))')); // Daiquiri
  assert(dqSteps[0]==='Chill the coupe.' && dqSteps.some(s=>/Shake hard.*15 seconds/.test(s)) && dqSteps.some(s=>/Double-strain/.test(s)), 'Daiquiri: chill, shake ~15s (the physics), double-strain up');
  const negSteps = JSON.parse(w.eval('JSON.stringify(stepsFor(S.recipes.find(r=>r.id==="r23")))')); // Negroni
  assert(negSteps.some(s=>/Stir about 95 seconds/.test(s)) && negSteps.some(s=>/big cube/.test(s)), 'Negroni: stir ~95s, over the big cube');
  const sazSteps = JSON.parse(w.eval('JSON.stringify(stepsFor(S.recipes.find(r=>r.id==="r08")))')); // Sazerac
  assert(sazSteps.some(s=>/Rinse the glass with the absinthe/.test(s)) && sazSteps.some(s=>/rinsed glass, no ice/.test(s)), 'Sazerac: the rinse pattern, served without ice');
  const wsSteps = JSON.parse(w.eval('JSON.stringify(stepsFor(S.recipes.find(r=>r.id==="r03")))')); // Whiskey Sour
  assert(wsSteps.some(s=>/Dry-shake/.test(s)), 'egg white earns the dry-shake');
  const mojSteps = JSON.parse(w.eval('JSON.stringify(stepsFor(S.recipes.find(r=>r.id==="r16")))')); // Mojito
  assert(mojSteps[0].includes('mint') && mojSteps.some(s=>/Top with the soda water/.test(s)), 'Mojito: mint first, bubbles last');
  const coSteps = JSON.parse(w.eval('JSON.stringify(stepsFor(S.recipes.find(r=>r.id==="r22")))')); // Corn 'n Oil
  assert(coSteps.some(s=>/Float the aged rum.*it holds/.test(s)), "Corn 'n Oil: the float step knows it holds");
  const f75Steps = JSON.parse(w.eval('JSON.stringify(stepsFor(S.recipes.find(r=>r.id==="r28")))')); // French 75
  const f75Shake = f75Steps.findIndex(s=>/Shake hard/.test(s)), f75Top = f75Steps.findIndex(s=>/Top with the sparkling wine/.test(s));
  assert(f75Shake>=0 && f75Top>f75Shake && !f75Steps.some(s=>/Combine.*sparkling/.test(s)), 'French 75: bubbles stay OUT of the shaker, topped after the strain');
  w.eval('openRecipeDetail("r15")'); await sleep(20);
  assert(d.getElementById('rd-steps')!==null && d.querySelectorAll('#rd-steps .step').length===dqSteps.length, 'the detail sheet walks the build step by step');
  w.eval('closeModal()'); await sleep(10);

  // ================= a tapped alert opens the spec =================
  assert(w.eval('handleSpecHash("#spec=' + encodeURIComponent('Daiquiri') + '")')===true, 'the #spec= hash from a cold-start alert is recognized');
  await sleep(30);
  assert(d.getElementById('modalwrap').classList.contains('on') && d.querySelector('#modal h2').textContent.includes('Daiquiri')
    && d.getElementById('rd-steps')!==null, 'it lands on the full Daiquiri spec, build steps and all');
  w.eval('closeModal()'); await sleep(10);
  assert(w.eval('openSpecByName("Corn \'n Oil")')===true, 'the warm-app path (service worker message) resolves names too');
  await sleep(20);
  assert(d.querySelector('#modal h2').textContent.includes("Corn 'n Oil"), 'and opens the right sheet');
  w.eval('closeModal()'); await sleep(10);
  assert(w.eval('openSpecByName("Zombie Apocalypse")')===false && w.eval('handleSpecHash("#s=abc123")')===false, 'unknown drinks toast politely; other hashes pass through untouched');
  w.eval('setTab("shelf")'); await sleep(10);

  // ================= the in-app request inbox opens specs too =================
  w.__reqStore = [{ drink:'Daiquiri', guest:'Maria' }];
  await w.openRequestInbox(); await sleep(60);
  const rqRow = d.querySelector('#modal .rq-row');
  assert(rqRow!==null && rqRow.dataset.drink==='Daiquiri', 'inbox rows are tappable and carry their drink');
  rqRow.click(); await sleep(30);
  assert(d.querySelector('#modal h2').textContent.includes('Daiquiri') && d.getElementById('rd-steps')!==null,
    'tapping an in-app request opens the full spec');
  w.eval('closeModal()'); await sleep(10);
  w.__reqStore = [];

  // stop the pollers so node can exit cleanly
  w.eval('stopBellPoll(); stopDusk(); if(_guestT){clearInterval(_guestT); _guestT=null;}');

  // --- persistence + migration guard ---
  await sleep(600); // let the debounced save flush
  const persisted = w.eval('JSON.parse(localStorage.getItem("bar-v1")||"null")');
  assert(persisted && persisted.v===1 && persisted.bottles.length===w.eval('S.bottles.length'), 'state persists to localStorage under bar-v1');
  w.eval('localStorage.setItem("bar-v1", JSON.stringify({v:99, alien:true}))');
  assert(w.eval('load().recipes.length')===81 && w.eval('load().bottles.length')===0, 'unknown schema version -> clean fresh state');
  assert(w.eval('!!localStorage.getItem("bar-v1-backup")'), 'migration guard keeps a backup of the unknown blob');
  w.eval('localStorage.setItem("bar-v1", "corrupted{{{")');
  assert(w.eval('load().recipes.length')===81, 'corrupted storage -> clean fresh state, no crash');

  assert(errors.length===0, 'no runtime errors across the whole run'+(errors.length?' -> '+errors.join(' | '):''));
  console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nall green');
})();
