/**
 * Home Bar worker: AI shelf-scan proxy.
 *
 * Deploy (Cloudflare Workers, free tier):
 *   1. dash.cloudflare.com -> Workers & Pages -> Create Worker
 *   2. Name it "home-bar" (so the URL becomes home-bar.<you>.workers.dev)
 *   3. Paste this whole file over the starter code -> Deploy
 *   4. Worker -> Settings -> Variables and Secrets -> add SECRET
 *        ANTHROPIC_API_KEY = <your Anthropic API key>
 *   5. Optional but recommended: add variable
 *        ALLOWED_ORIGIN = https://cjmerc39.github.io
 *
 * For short shareable menu links (POST /menu, GET /m/<id>) you ALSO need a
 * KV namespace (a tiny key-value store, free tier):
 *   6. dash.cloudflare.com -> Storage & Databases -> KV -> Create namespace,
 *      name it "home-bar-menus"
 *   7. Worker -> Settings -> Bindings -> Add -> KV namespace ->
 *      Variable name: MENUS, Namespace: home-bar-menus -> Save
 *
 * POST /scan     -> { media_type, data } in (base64 image), { bottles: [...] } out.
 * POST /recipe   -> { text } or { media_type, data } (+ optional staples[]) in,
 *                   { recipe: {...} } out — drafts a structured cocktail spec.
 * POST /menu       -> menu payload in, { id, owner } out (stored 90 days in
 *                     KV; keep the owner token secret — it edits the menu).
 * PUT  /menu/:id   -> updated payload in (Bearer <owner>), updates in place
 *                     so guests' links stay live. 403 on a wrong owner.
 * DELETE /menu/:id -> (Bearer <owner>) revoke the link: menu, owner, and
 *                     pending requests all deleted.
 * GET  /menu/:id   -> the stored payload as JSON, no-store (guests refetch).
 * GET  /m/:id      -> a tiny HTML page with link-preview tags (title = menu
 *                     title) that forwards guests to the app.
 * PUT  /sync       -> full app state in (Bearer <backup code>), stored in KV.
 * GET  /sync       -> the stored state back (same Bearer code). Powers the
 *                     app's automatic cloud backup / restore-on-new-phone.
 * POST /bartender  -> { mood, drinks } in, { picks: [{name, why}] } out — the
 *                     AI recommends from tonight's makeable list.
 * POST /menu/:id/req   -> { drink, guest? } — a guest requests a drink (open).
 * GET  /menu/:id/req   -> { requests } — the host's inbox (Bearer <owner>).
 * DELETE /menu/:id/req -> clear the inbox (Bearer <owner>).
 * The API key never leaves the worker.
 */

const CATEGORIES = ['tequila','mezcal','whiskey','rum','gin','vodka','brandy','amaro','liqueur','vermouth','bitters','wine','mixer','spice','milk','other'];
const UNITS = ['oz','ml','cup','gallon','dash','tsp','bsp','drop','leaf','wedge','pinch','rinse','top','whole'];
const METHODS = ['stir','shake','build','blend'];
const DEFAULT_STAPLES = ['lime','lemon','sugar','simple syrup','honey','agave syrup','egg white','mint','salt','espresso','coconut cream','cream'];
const IMAGE_TYPES = ['image/jpeg','image/png','image/webp'];
const MAX_B64 = 11 * 1024 * 1024; // ~8MB of image as base64

const SUBTYPE_CONVENTIONS = [
  'tequila: blanco/reposado/anejo; whiskey: bourbon/rye/scotch/japanese/irish;',
  'rum: white/aged/dark/overproof; vermouth: sweet/dry; bitters: aromatic/orange/peychauds/mole;',
  'amaro: campari/aperol/nonino/averna/fernet; wine: sparkling/red/white;',
  'liqueur: orange/maraschino/green chartreuse/yellow chartreuse/amaretto/coffee/falernum/absinthe;',
  'mixer: soda water/tonic/ginger beer/grapefruit soda/cola/pineapple juice/grapefruit juice/orgeat.',
].join(' ');

const SCAN_PROMPT = [
  'This is a photo of a home bar. Identify every liquor, spirit, liqueur, amaro,',
  'vermouth, bitters, wine, and mixer bottle you can see.',
  'For each bottle give the exact brand and expression when the label is legible',
  '(e.g. "Mijenta Reposado", "Amaro Nonino Quintessentia", "Angostura Aromatic Bitters").',
  'Categorize each into exactly one of: ' + CATEGORIES.join(', ') + '.',
  'Where it applies, add a lowercase subtype from conventions like:',
  'tequila: blanco/reposado/anejo; whiskey: bourbon/rye/scotch/japanese/irish;',
  'rum: white/aged/dark/overproof; vermouth: sweet/dry; bitters: aromatic/orange/peychauds/mole;',
  'amaro: campari/aperol/nonino/averna/fernet; wine: sparkling/red/white;',
  'liqueur: orange/maraschino/green chartreuse/yellow chartreuse/amaretto/coffee/falernum/absinthe;',
  'mixer: soda water/tonic/ginger beer/grapefruit soda/cola.',
  'Skip glassware, decor, and anything that is not a bottle of something drinkable.',
  'If a label is only partly readable, still include the bottle with your best-guess',
  'name and append " (unsure)" to the name.',
  'When you can, also give each bottle a box: its bounding box in the image as',
  '{x, y, w, h}, each a number from 0 to 1 normalized to the image width/height,',
  'drawn tight around that one bottle. Omit box when you are not sure where it is.',
].join(' ');

const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    bottles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES },
          subtype: { type: 'string' },
          box: { // optional: normalized 0..1 bounding box, tight around the bottle
            type: 'object',
            properties: {
              x: { type: 'number', minimum: 0, maximum: 1 },
              y: { type: 'number', minimum: 0, maximum: 1 },
              w: { type: 'number', minimum: 0, maximum: 1 },
              h: { type: 'number', minimum: 0, maximum: 1 },
            },
            required: ['x', 'y', 'w', 'h'],
            additionalProperties: false,
          },
        },
        required: ['name', 'category'],
        additionalProperties: false,
      },
    },
  },
  required: ['bottles'],
  additionalProperties: false,
};

export default {
  async fetch(request, env) {
    const cors = {
      'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const path = new URL(request.url).pathname;
    if (path === '/scan' && request.method === 'POST') return scan(request, env, cors);
    if (path === '/recipe' && request.method === 'POST') return recipe(request, env, cors);
    if (path === '/sync') return sync(request, env, cors);
    if (path === '/bartender' && request.method === 'POST') return bartender(request, env, cors);
    const mReq = /^\/menu\/([A-Za-z0-9]{4,32})\/req$/.exec(path);
    if (mReq && request.method === 'POST') return reqAdd(mReq[1], request, env, cors);
    if (mReq && request.method === 'GET') return reqList(mReq[1], request, env, cors);
    if (mReq && request.method === 'DELETE') return reqClear(mReq[1], request, env, cors);
    if (path === '/menu' && request.method === 'POST') return menuCreate(request, env, cors);
    const mGet = /^\/menu\/([A-Za-z0-9]{4,32})$/.exec(path);
    if (mGet && request.method === 'GET') return menuGet(mGet[1], env, cors);
    if (mGet && request.method === 'PUT') return menuUpdate(mGet[1], request, env, cors);
    if (mGet && request.method === 'DELETE') return menuDelete(mGet[1], request, env, cors);
    const mPage = /^\/m\/([A-Za-z0-9]{4,32})$/.exec(path);
    if (mPage && request.method === 'GET') return menuPage(mPage[1], env);
    return json({ error: 'not found' }, 404, cors);
  },
};

async function scan(request, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY secret not set on the worker' }, 500, cors);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad request body' }, 400, cors); }
  const mediaType = String(body && body.media_type || '');
  const data = String(body && body.data || '');
  if (!IMAGE_TYPES.includes(mediaType)) return json({ error: 'media_type must be image/jpeg, image/png, or image/webp' }, 400, cors);
  if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) return json({ error: 'data must be base64' }, 400, cors);
  if (data.length > MAX_B64) return json({ error: 'image too large — resize below ~8MB' }, 413, cors);

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
          { type: 'text', text: SCAN_PROMPT },
        ],
      }],
      output_config: { format: { type: 'json_schema', schema: SCAN_SCHEMA } },
    }),
  });
  const resp = await r.json().catch(() => null);
  if (!r.ok) return json({ error: (resp && resp.error && resp.error.message) || 'api error' }, 502, cors);
  if (resp && resp.stop_reason === 'refusal') return json({ error: 'the model declined to read this image' }, 502, cors);

  const text = ((resp && resp.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { return json({ error: 'could not parse model output' }, 502, cors); }
  const bottles = Array.isArray(parsed && parsed.bottles) ? parsed.bottles : [];
  return json({ bottles }, 200, cors);
}

/* ---- /recipe : draft a structured cocktail spec from text or a photo ---- */
const RECIPE_SCHEMA = {
  type: 'object',
  properties: {
    recipe: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        method: { type: 'string', enum: METHODS },
        glass: { type: 'string' },
        garnish: { type: 'string' },
        notes: { type: 'string' },
        servings: { type: 'integer' },
        ingredients: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              qty: { type: 'string' },
              unit: { type: 'string', enum: UNITS },
              kind: { type: 'string', enum: ['tag', 'staple'] },
              category: { type: 'string', enum: CATEGORIES },
              subtype: { type: 'string' },
              staple: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['kind'],
            additionalProperties: false,
          },
        },
      },
      required: ['name', 'method', 'ingredients'],
      additionalProperties: false,
    },
  },
  required: ['recipe'],
  additionalProperties: false,
};

function recipePrompt(staples) {
  return 'Turn the given cocktail (described in text, or photographed from a book/card) into ONE structured recipe. ' +
    'Ingredient rules: spices (cinnamon, nutmeg, clove, vanilla…) are kind:"tag" with category "spice" and the spice name ' +
    'as the lowercase subtype. Milks and creams (coconut milk, condensed milk, evaporated milk…) are kind:"tag" with ' +
    'category "milk" and the milk name as the subtype. Any other household ingredient (citrus, syrup, eggs, coffee, mint) ' +
    'is kind:"staple" with a short lowercase name — use the exact string from this list when one matches: [' +
    staples.join(', ') + '], otherwise a sensible short name. ' +
    'Never use category "other" for pantry items. Alcoholic spirits are NEVER staples and never category "other" — ' +
    'a brand implies its spirit (NOLET’S or Tanqueray = gin; Tito’s = vodka; Maker’s Mark = whiskey subtype bourbon). ' +
    'Everything alcoholic or bottled from a store is kind:"tag" with a category from the allowed list and, ' +
    'when meaningful, a lowercase subtype following these conventions: ' + SUBTYPE_CONVENTIONS + ' ' +
    'qty is a plain decimal string like "0.75". Keep glass and garnish short. Put technique tips in notes. ' +
    'Set servings to how many drinks the spec makes as written (1 for a single cocktail; batch recipes like coquito often make 8-12). ' +
    'If the source names a specific brand, put the generic tag in the ingredient and mention the brand in notes.';
}

async function recipe(request, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY secret not set on the worker' }, 500, cors);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad request body' }, 400, cors); }
  const text = String(body && body.text || '').slice(0, 4000);
  const mediaType = String(body && body.media_type || '');
  const data = String(body && body.data || '');
  const staples = (Array.isArray(body && body.staples) ? body.staples : DEFAULT_STAPLES)
    .slice(0, 50).map((s) => String(s).slice(0, 40));
  const hasImage = mediaType && data;
  if (!text && !hasImage) return json({ error: 'send text or an image' }, 400, cors);
  if (hasImage) {
    if (!IMAGE_TYPES.includes(mediaType)) return json({ error: 'media_type must be image/jpeg, image/png, or image/webp' }, 400, cors);
    if (!/^[A-Za-z0-9+/=]+$/.test(data)) return json({ error: 'data must be base64' }, 400, cors);
    if (data.length > MAX_B64) return json({ error: 'image too large — resize below ~8MB' }, 413, cors);
  }

  const content = [];
  if (hasImage) content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
  content.push({ type: 'text', text: recipePrompt(staples) + (text ? '\n\nThe drink: ' + text : '') });

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 2000,
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema: RECIPE_SCHEMA } },
    }),
  });
  const resp = await r.json().catch(() => null);
  if (!r.ok) return json({ error: (resp && resp.error && resp.error.message) || 'api error' }, 502, cors);
  if (resp && resp.stop_reason === 'refusal') return json({ error: 'the model declined this request' }, 502, cors);

  const out = ((resp && resp.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  let parsed;
  try { parsed = JSON.parse(out); } catch (e) { return json({ error: 'could not parse model output' }, 502, cors); }
  if (!parsed || !parsed.recipe) return json({ error: 'no recipe in model output' }, 502, cors);
  return json({ recipe: parsed.recipe }, 200, cors);
}

/* ---- /sync : automatic cloud backup (bearer code = the only access control) ---- */
async function sync(request, env, cors) {
  if (!env.MENUS) return json({ error: 'KV namespace MENUS not bound — see the deploy steps at the top of this file' }, 500, cors);
  const m = /^Bearer ([a-f0-9]{32,64})$/.exec(request.headers.get('authorization') || '');
  if (!m) return json({ error: 'unauthorized' }, 401, cors);
  const key = 'sync:' + m[1];
  if (request.method === 'GET') {
    const v = await env.MENUS.get(key);
    if (!v) return json({ error: 'no backup found for this code' }, 404, cors);
    return new Response(v, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', ...cors } });
  }
  if (request.method === 'PUT') {
    const body = await request.text();
    if (body.length > 4 * 1024 * 1024) return json({ error: 'backup too large' }, 413, cors);
    try { JSON.parse(body); } catch (e) { return json({ error: 'body is not JSON' }, 400, cors); }
    await env.MENUS.put(key, body); // no TTL — backups persist
    return json({ ok: true }, 200, cors);
  }
  return json({ error: 'method not allowed' }, 405, cors);
}

/* ---- /bartender : recommend from tonight's makeable list ---- */
const BARTENDER_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, why: { type: 'string' } },
        required: ['name', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['picks'],
  additionalProperties: false,
};

async function bartender(request, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY secret not set on the worker' }, 500, cors);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad request body' }, 400, cors); }
  const mood = String(body && body.mood || '').slice(0, 300);
  const drinks = (Array.isArray(body && body.drinks) ? body.drinks : []).slice(0, 80).map((x) => ({
    name: String(x && x.name || '').slice(0, 80),
    base: String(x && x.base || '').slice(0, 20),
    rating: Math.max(0, Math.min(5, parseInt(x && x.rating, 10) || 0)),
    house: !!(x && x.house),
    low: !!(x && x.low),
    ingredients: String(x && x.ingredients || '').slice(0, 200),
  })).filter((x) => x.name);
  if (!drinks.length) return json({ error: 'no makeable drinks provided' }, 400, cors);

  const prompt = 'You are the house bartender at a small, warm home bar. From the list of drinks that can be made ' +
    'RIGHT NOW (with base spirit, the owner\'s 0-5 rating, house flag for their own creations, and a low flag meaning ' +
    'a key bottle is nearly empty), pick 2-3 to recommend for tonight. Rules: the name field must EXACTLY match a ' +
    'name from the list. Vary the base spirits across your picks when sensible. Weigh the mood/occasion heavily if ' +
    'given. A high rating means the owner loves it; a house drink is their pride. If a pick is flagged low, you may ' +
    'note it kindly (last call for that bottle). Each why is ONE warm, specific sentence a good bartender would ' +
    'actually say, under 140 characters — no lists, no hedging.\n\n' +
    'MOOD/OCCASION: ' + (mood || '(none given — use your judgment)') + '\n\nDRINKS:\n' + JSON.stringify(drinks);

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: { type: 'json_schema', schema: BARTENDER_SCHEMA } },
    }),
  });
  const resp = await r.json().catch(() => null);
  if (!r.ok) return json({ error: (resp && resp.error && resp.error.message) || 'api error' }, 502, cors);
  if (resp && resp.stop_reason === 'refusal') return json({ error: 'the model declined this request' }, 502, cors);
  const out = ((resp && resp.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  let parsed;
  try { parsed = JSON.parse(out); } catch (e) { return json({ error: 'could not parse model output' }, 502, cors); }
  const names = new Set(drinks.map((d) => d.name.toLowerCase()));
  const picks = (Array.isArray(parsed && parsed.picks) ? parsed.picks : [])
    .filter((p) => p && names.has(String(p.name || '').toLowerCase())).slice(0, 3);
  return json({ picks }, 200, cors);
}

/* ---- /menu/:id/req : guest drink requests ---- */
async function reqAdd(id, request, env, cors) {
  if (!env.MENUS) return json({ error: 'KV namespace MENUS not bound' }, 500, cors);
  const menu = await env.MENUS.get('m:' + id);
  if (!menu) return json({ error: 'menu expired' }, 404, cors);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad request body' }, 400, cors); }
  const drink = String(body && body.drink || '').slice(0, 80).trim();
  const guest = String(body && body.guest || '').slice(0, 40).trim();
  if (!drink) return json({ error: 'no drink named' }, 400, cors);
  let list = [];
  try { list = JSON.parse(await env.MENUS.get('req:' + id) || '[]'); } catch (e) {}
  if (!Array.isArray(list)) list = [];
  if (list.length >= 100) return json({ error: 'the request box is full' }, 429, cors);
  list.push({ d: drink, g: guest, at: Date.now() });
  await env.MENUS.put('req:' + id, JSON.stringify(list), { expirationTtl: MENU_TTL });
  return json({ ok: true, count: list.length }, 200, cors);
}
async function reqList(id, request, env, cors) {
  if (!env.MENUS) return json({ error: 'KV namespace MENUS not bound' }, 500, cors);
  if (!(await menuOwnerOk(id, request, env))) return json({ error: 'forbidden' }, 403, cors);
  let list = [];
  try { list = JSON.parse(await env.MENUS.get('req:' + id) || '[]'); } catch (e) {}
  return json({ requests: Array.isArray(list) ? list : [] }, 200, cors);
}
async function reqClear(id, request, env, cors) {
  if (!env.MENUS) return json({ error: 'KV namespace MENUS not bound' }, 500, cors);
  if (!(await menuOwnerOk(id, request, env))) return json({ error: 'forbidden' }, 403, cors);
  await env.MENUS.delete('req:' + id);
  return json({ ok: true }, 200, cors);
}

/* ---- /menu + /m : short shareable menu links (KV-backed, 90-day TTL) ---- */
const MENU_TTL = 90 * 24 * 60 * 60;
const APP_URL_DEFAULT = 'https://cjmerc39.github.io/home-bar/';

function cleanMenuPayload(p) {
  if (!p || typeof p.t !== 'string' || !Array.isArray(p.c) || !Array.isArray(p.s)) return null;
  const t = p.t.slice(0, 80);
  const c = p.c.slice(0, 100)
    .map((x) => {
      const it = { n: String(x && x.n || '').slice(0, 80), d: String(x && x.d || '').slice(0, 300), h: !!(x && x.h) };
      if (x && x.x) it.x = true; // 86'd
      return it;
    })
    .filter((x) => x.n);
  const s = p.s.slice(0, 100)
    .map((x) => ({ n: String(x && x.n || '').slice(0, 80), c: String(x && x.c || '').slice(0, 20), t: String(x && x.t || '').slice(0, 40) }))
    .filter((x) => x.n);
  const out = { t, c, s };
  if (p.f && typeof p.f === 'object' && p.f.n) {
    out.f = { label: String(p.f.label || 'drink of the night').slice(0, 60),
      n: String(p.f.n).slice(0, 80), d: String(p.f.d || '').slice(0, 300), h: !!p.f.h };
  }
  if (Array.isArray(p.b) && p.b.length) {
    out.b = p.b.slice(0, 50).map((x) => String(x || '').slice(0, 60)).filter(Boolean);
  }
  return out;
}
function menuId() {
  const a = crypto.getRandomValues(new Uint8Array(8));
  return [...a].map((b) => (b % 36).toString(36)).join('');
}
function ownerToken() {
  const a = crypto.getRandomValues(new Uint8Array(16));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function bearer(request) {
  const m = /^Bearer ([a-f0-9]{32,64})$/.exec(request.headers.get('authorization') || '');
  return m ? m[1] : null;
}
// legacy ids (pre-owner) have no o: key and therefore fail every owner check
async function menuOwnerOk(id, request, env) {
  const tok = bearer(request);
  if (!tok) return false;
  const stored = await env.MENUS.get('o:' + id);
  return !!stored && stored === tok;
}
async function menuCreate(request, env, cors) {
  if (!env.MENUS) return json({ error: 'KV namespace MENUS not bound — see the deploy steps at the top of this file' }, 500, cors);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad request body' }, 400, cors); }
  const clean = cleanMenuPayload(body);
  if (!clean) return json({ error: 'not a menu payload' }, 400, cors);
  const blob = JSON.stringify(clean);
  if (blob.length > 32768) return json({ error: 'menu too large' }, 413, cors);
  const id = menuId();
  const owner = ownerToken();
  await env.MENUS.put('m:' + id, blob, { expirationTtl: MENU_TTL });
  await env.MENUS.put('o:' + id, owner, { expirationTtl: MENU_TTL });
  return json({ id, owner }, 200, cors);
}
async function menuUpdate(id, request, env, cors) {
  if (!env.MENUS) return json({ error: 'KV namespace MENUS not bound' }, 500, cors);
  if (!(await menuOwnerOk(id, request, env))) return json({ error: 'forbidden' }, 403, cors);
  if (!(await env.MENUS.get('m:' + id))) return json({ error: 'menu expired' }, 404, cors);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad request body' }, 400, cors); }
  const clean = cleanMenuPayload(body);
  if (!clean) return json({ error: 'not a menu payload' }, 400, cors);
  const blob = JSON.stringify(clean);
  if (blob.length > 32768) return json({ error: 'menu too large' }, 413, cors);
  await env.MENUS.put('m:' + id, blob, { expirationTtl: MENU_TTL });                      // refresh TTL
  await env.MENUS.put('o:' + id, bearer(request), { expirationTtl: MENU_TTL });           // keep owner alive as long as the menu
  return json({ ok: true }, 200, cors);
}
async function menuDelete(id, request, env, cors) {
  if (!env.MENUS) return json({ error: 'KV namespace MENUS not bound' }, 500, cors);
  if (!(await menuOwnerOk(id, request, env))) return json({ error: 'forbidden' }, 403, cors);
  await env.MENUS.delete('m:' + id);
  await env.MENUS.delete('o:' + id);
  await env.MENUS.delete('req:' + id);
  return json({ ok: true }, 200, cors);
}
async function menuGet(id, env, cors) {
  if (!env.MENUS) return json({ error: 'KV namespace MENUS not bound' }, 500, cors);
  const v = await env.MENUS.get('m:' + id);
  if (!v) return json({ error: 'menu expired' }, 404, cors);
  return new Response(v, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors },
  });
}
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
async function menuPage(id, env) {
  const appUrl = env.APP_URL || APP_URL_DEFAULT;
  const v = env.MENUS ? await env.MENUS.get('m:' + id) : null;
  const headers = { 'content-type': 'text/html; charset=utf-8' };
  if (!v) {
    return new Response('<!doctype html><meta charset="utf-8"><title>Menu expired</title>' +
      '<body style="background:#1a1410;color:#b7a789;font-family:Georgia,serif;text-align:center;padding-top:30vh">' +
      'This menu link has expired.<br><a style="color:#c9a15a" href="' + escHtml(appUrl) + '">Home Bar</a></body>', { status: 404, headers });
  }
  let p; try { p = JSON.parse(v); } catch (e) { p = { t: 'Menu', c: [], s: [] }; }
  const names = p.c.slice(0, 3).map((x) => x.n).join(', ');
  const desc = (p.c.length ? p.c.length + ' cocktail' + (p.c.length === 1 ? '' : 's') + ' tonight' + (names ? ' — ' + names + (p.c.length > 3 ? ' & more' : '') : '') : 'Tonight’s menu') +
    (p.s.length ? ' · ' + p.s.length + ' by the pour' : '');
  const target = appUrl + '#s=' + id;
  return new Response('<!doctype html><html><head><meta charset="utf-8">' +
    '<title>' + escHtml(p.t) + '</title>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta property="og:title" content="' + escHtml(p.t) + '">' +
    '<meta property="og:description" content="' + escHtml(desc) + '">' +
    '<meta property="og:image" content="' + escHtml(appUrl) + 'icon-512.png">' +
    '<meta property="og:type" content="website">' +
    '<meta name="twitter:card" content="summary">' +
    '</head><body style="background:#1a1410;color:#f1e6d0;font-family:Georgia,serif;text-align:center;padding-top:30vh">' +
    'Opening ' + escHtml(p.t) + '&hellip;' +
    '<script>location.replace(' + JSON.stringify(target) + ')</script>' +
    '<noscript><br><a style="color:#c9a15a" href="' + escHtml(target) + '">Open the menu</a></noscript>' +
    '</body></html>', { status: 200, headers });
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
