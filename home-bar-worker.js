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
 * POST /menu     -> menu payload in, { id } out (stored 90 days in KV).
 * GET  /menu/:id -> the stored payload as JSON (used by the app).
 * GET  /m/:id    -> a tiny HTML page with link-preview tags (title = menu
 *                   title) that forwards guests to the app.
 * PUT  /sync     -> full app state in (Bearer <backup code>), stored in KV.
 * GET  /sync     -> the stored state back (same Bearer code). Powers the
 *                   app's automatic cloud backup / restore-on-new-phone.
 * The API key never leaves the worker.
 */

const CATEGORIES = ['tequila','mezcal','whiskey','rum','gin','vodka','brandy','amaro','liqueur','vermouth','bitters','wine','mixer','other'];
const UNITS = ['oz','ml','dash','tsp','bsp','drop','leaf','wedge','pinch','rinse','top','whole'];
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
      'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const path = new URL(request.url).pathname;
    if (path === '/scan' && request.method === 'POST') return scan(request, env, cors);
    if (path === '/recipe' && request.method === 'POST') return recipe(request, env, cors);
    if (path === '/sync') return sync(request, env, cors);
    if (path === '/menu' && request.method === 'POST') return menuCreate(request, env, cors);
    const mGet = /^\/menu\/([A-Za-z0-9]{4,32})$/.exec(path);
    if (mGet && request.method === 'GET') return menuGet(mGet[1], env, cors);
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
    'Ingredient rules: any household or pantry ingredient (citrus, syrup, spice, dairy, eggs, coffee, coconut milk, etc.) ' +
    'is kind:"staple" with a short lowercase name — use the exact string from this list when one matches: [' +
    staples.join(', ') + '], otherwise invent a sensible short name (e.g. "cinnamon", "condensed milk"). ' +
    'Never file spices, milks, syrups, juices, or other pantry items under kind:"tag" with category "other" — they are staples. ' +
    'Everything alcoholic or bottled from a store is kind:"tag" with a category from the allowed list and, ' +
    'when meaningful, a lowercase subtype following these conventions: ' + SUBTYPE_CONVENTIONS + ' ' +
    'qty is a plain decimal string like "0.75". Keep glass and garnish short. Put technique tips in notes. ' +
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
  return out;
}
function menuId() {
  const a = crypto.getRandomValues(new Uint8Array(8));
  return [...a].map((b) => (b % 36).toString(36)).join('');
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
  await env.MENUS.put('m:' + id, blob, { expirationTtl: MENU_TTL });
  return json({ id }, 200, cors);
}
async function menuGet(id, env, cors) {
  if (!env.MENUS) return json({ error: 'KV namespace MENUS not bound' }, 500, cors);
  const v = await env.MENUS.get('m:' + id);
  if (!v) return json({ error: 'menu expired' }, 404, cors);
  return new Response(v, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600', ...cors },
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
