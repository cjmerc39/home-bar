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
 * POST /scan -> { media_type, data } in (base64 image), { bottles: [...] } out.
 * The API key never leaves the worker.
 */

const CATEGORIES = ['tequila','mezcal','whiskey','rum','gin','vodka','brandy','amaro','liqueur','vermouth','bitters','wine','mixer','other'];
const IMAGE_TYPES = ['image/jpeg','image/png','image/webp'];
const MAX_B64 = 11 * 1024 * 1024; // ~8MB of image as base64

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
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const path = new URL(request.url).pathname;
    if (path === '/scan' && request.method === 'POST') return scan(request, env, cors);
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

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
