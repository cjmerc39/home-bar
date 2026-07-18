// Worker test suite — plain `node home-bar-worker.test.js`, no framework.
// The worker is an ES module in a CJS package, so we load it by rewriting
// `export default` and evaluating the source (Request/Response/fetch/crypto
// are all Node globals since 18+).
const fs = require('fs');

function loadWorker(){
  const src = fs.readFileSync(__dirname + '/home-bar-worker.js', 'utf8')
    .replace(/^export default/m, 'module.exports.default =');
  const mod = { exports: {} };
  new Function('module', 'exports', src)(mod, mod.exports);
  return mod.exports.default;
}

function makeEnv(){
  const store = new Map();
  return {
    ANTHROPIC_API_KEY: 'test-key',
    ALLOWED_ORIGIN: 'https://example.test',
    MENUS: {
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v, opts) => { store.set(k, v); },       // TTL accepted, ignored
      delete: async (k) => { store.delete(k); },
    },
    __store: store,
  };
}

// stub api.anthropic.com — records request bodies, answers per __anthropicReply.
// push.test endpoints are recorded separately (binary bodies, controllable status).
let anthropicCalls = [];
let anthropicReply = null;
let pushCalls = [];
let pushStatus = 201;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://push.test/')) {
    pushCalls.push({ url: u, headers: opts.headers, body: opts.body });
    return { ok: pushStatus < 300, status: pushStatus, json: async () => ({}) };
  }
  anthropicCalls.push({ url: u, body: JSON.parse(opts.body) });
  return { ok: true, status: 200, json: async () => anthropicReply };
};
const textReply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn' });

const req = (path, opts) => new Request('https://worker.test' + path, opts);
const jbody = (o) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });

(async () => {
  const assert = (c, m) => { if(!c){ console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  :', m); };
  const worker = loadWorker();
  const env = makeEnv();
  const call = (path, opts, ctx) => worker.fetch(req(path, opts), env, ctx);

  // --- CORS preflight ---
  let r = await call('/scan', { method: 'OPTIONS' });
  assert(r.headers.get('access-control-allow-origin') === 'https://example.test', 'preflight echoes ALLOWED_ORIGIN');
  assert(/PUT/.test(r.headers.get('access-control-allow-methods')) && /DELETE/.test(r.headers.get('access-control-allow-methods')), 'preflight allows PUT and DELETE');
  assert(/authorization/.test(r.headers.get('access-control-allow-headers')), 'preflight allows the authorization header');

  // --- /scan validation ---
  r = await call('/scan', jbody({ media_type: 'image/tiff', data: 'aGk=' }));
  assert(r.status === 400, 'scan rejects a bad media type');
  r = await call('/scan', jbody({ media_type: 'image/jpeg', data: 'not base64!!!' }));
  assert(r.status === 400, 'scan rejects non-base64 data');
  r = await call('/scan', jbody({ media_type: 'image/jpeg', data: 'A'.repeat(11 * 1024 * 1024 + 4) }));
  assert(r.status === 413, 'scan rejects an oversize image with 413');
  anthropicReply = textReply({ bottles: [{ name: 'Campari', category: 'amaro', subtype: 'campari' }] });
  r = await call('/scan', jbody({ media_type: 'image/jpeg', data: 'aGVsbG8=' }));
  let j = await r.json();
  assert(r.status === 200 && j.bottles.length === 1 && j.bottles[0].name === 'Campari', 'scan happy path parses the model output');
  assert(anthropicCalls[0].body.model === 'claude-opus-4-8' && anthropicCalls[0].body.messages[0].content[0].type === 'image', 'scan sends the image to the model');
  const itemProps = anthropicCalls[0].body.output_config.format.schema.properties.bottles.items;
  assert(!!itemProps.properties.box && !itemProps.required.includes('box'), 'scan schema offers box but never requires it');
  // the API's structured-output validator 400s on numeric range constraints —
  // shipping minimum/maximum in any schema breaks the endpoint outright
  const schemaStr = JSON.stringify(anthropicCalls[0].body.output_config.format.schema);
  assert(!/"minimum"|"maximum"/.test(schemaStr), 'scan schema carries no minimum/maximum (the API rejects them)');
  anthropicReply = textReply({ bottles: [
    { name: 'Boxed Gin', category: 'gin', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
    { name: 'Plain Rum', category: 'rum' },
  ] });
  r = await call('/scan', jbody({ media_type: 'image/jpeg', data: 'aGVsbG8=' }));
  j = await r.json();
  assert(r.status === 200 && j.bottles[0].box && j.bottles[0].box.w === 0.3, 'a scan response with a box passes through intact');
  assert(j.bottles[1].box === undefined, 'a scan response without a box also validates');

  // --- /recipe validation + paths ---
  r = await call('/recipe', jbody({}));
  assert(r.status === 400, 'recipe rejects a request with neither text nor image');
  anthropicCalls = [];
  anthropicReply = textReply({ recipe: { name: 'Test', method: 'shake', servings: 2, ingredients: [{ kind: 'staple', staple: 'lime', qty: '1', unit: 'oz' }] } });
  r = await call('/recipe', jbody({ text: 'a lime thing' }));
  j = await r.json();
  assert(r.status === 200 && j.recipe.name === 'Test' && j.recipe.servings === 2, 'recipe text path returns the drafted recipe');
  assert(anthropicCalls[0].body.messages[0].content[0].type === 'text', 'text-only draft sends no image block');
  anthropicCalls = [];
  r = await call('/recipe', jbody({ media_type: 'image/png', data: 'aGVsbG8=' }));
  assert(r.status === 200 && anthropicCalls[0].body.messages[0].content[0].type === 'image', 'recipe image path sends the image block first');

  // --- /menu create / get / update / delete ---
  r = await call('/menu', jbody({ t: "CJ's Bar", c: [{ n: 'Negroni', d: 'gin, Campari, sweet vermouth', h: true }], s: [{ n: 'Sipsmith', c: 'gin', t: 'london dry' }] }));
  j = await r.json();
  assert(r.status === 200 && /^[a-z0-9]{8}$/.test(j.id), 'menu create returns an id');
  assert(/^[a-f0-9]{32}$/.test(j.owner), 'menu create returns a 32-hex owner token');
  const id = j.id, owner = j.owner;
  assert(env.__store.has('m:' + id) && env.__store.get('o:' + id) === owner, 'payload and owner both stored');

  r = await call('/menu/' + id, { method: 'GET' });
  j = await r.json();
  assert(r.status === 200 && j.t === "CJ's Bar" && j.c[0].n === 'Negroni', 'menu GET serves the payload');
  assert((await call('/menu/' + id, { method: 'GET' })).headers.get('cache-control') === 'no-store', 'menu GET is no-store so guests see updates');

  r = await call('/menu/' + id, { method: 'PUT', headers: { authorization: 'Bearer ' + 'f'.repeat(32) }, body: JSON.stringify({ t: 'Hacked', c: [], s: [] }) });
  assert(r.status === 403, 'menu PUT with the wrong owner is 403');
  assert(JSON.parse(env.__store.get('m:' + id)).t === "CJ's Bar", 'payload untouched after the rejected PUT');
  r = await call('/menu/' + id, { method: 'PUT', headers: { authorization: 'Bearer ' + owner }, body: JSON.stringify({ t: "CJ's Bar", c: [{ n: 'Negroni', d: 'x', h: true, x: true }], s: [] }) });
  assert(r.status === 200 && JSON.parse(env.__store.get('m:' + id)).c[0].x === true, 'menu PUT with the right owner updates in place');

  // --- requests: POST open, GET/DELETE owner-gated ---
  r = await call('/menu/' + id + '/req', jbody({ drink: 'Negroni', guest: 'Maria' }));
  assert(r.status === 200, 'guest request POST is open (no auth)');
  r = await call('/menu/' + id + '/req', { method: 'GET' });
  assert(r.status === 403, 'inbox GET without the owner token is 403');
  r = await call('/menu/' + id + '/req', { method: 'GET', headers: { authorization: 'Bearer ' + owner } });
  j = await r.json();
  assert(r.status === 200 && j.requests.length === 1 && j.requests[0].d === 'Negroni' && j.requests[0].g === 'Maria', 'inbox GET with the owner token lists requests');
  r = await call('/menu/' + id + '/req', { method: 'DELETE' });
  assert(r.status === 403, 'inbox clear without the owner token is 403');
  r = await call('/menu/' + id + '/req', { method: 'DELETE', headers: { authorization: 'Bearer ' + owner } });
  assert(r.status === 200 && !env.__store.has('req:' + id), 'inbox clear with the owner token empties it');

  r = await call('/menu/' + id, { method: 'DELETE', headers: { authorization: 'Bearer ' + owner } });
  assert(r.status === 200 && !env.__store.has('m:' + id) && !env.__store.has('o:' + id) && !env.__store.has('req:' + id), 'menu DELETE removes payload, owner, and requests');
  r = await call('/menu/' + id, { method: 'GET' });
  assert(r.status === 404, 'a revoked link 404s for guests');

  // --- /sync ---
  r = await call('/sync', { method: 'GET' });
  assert(r.status === 401, 'sync without a bearer code is 401');
  r = await call('/sync', { method: 'GET', headers: { authorization: 'Bearer ' + 'a'.repeat(32) } });
  assert(r.status === 404, 'sync GET with an unknown code is 404');
  const code = 'b'.repeat(32);
  r = await call('/sync', { method: 'PUT', headers: { authorization: 'Bearer ' + code }, body: JSON.stringify({ v: 1, savedAt: 42 }) });
  assert(r.status === 200, 'sync PUT stores the backup');
  r = await call('/sync', { method: 'GET', headers: { authorization: 'Bearer ' + code } });
  j = await r.json();
  assert(r.status === 200 && j.savedAt === 42, 'sync GET round-trips the backup');
  r = await call('/sync', { method: 'PUT', headers: { authorization: 'Bearer ' + code }, body: '"' + 'x'.repeat(4 * 1024 * 1024) + '"' });
  assert(r.status === 413, 'sync PUT over 4MB is 413');

  // --- /bartender filters picks to real names ---
  anthropicReply = textReply({ picks: [{ name: 'Gimlet', why: 'crisp' }, { name: 'Imaginary Drink', why: 'nope' }] });
  r = await call('/bartender', jbody({ mood: 'hot day', drinks: [{ name: 'Gimlet', base: 'gin', rating: 5, house: false, low: false, ingredients: 'gin, lime' }] }));
  j = await r.json();
  assert(r.status === 200 && j.picks.length === 1 && j.picks[0].name === 'Gimlet', 'bartender drops picks that are not on the provided list');

  // --- /bartender optional weather ---
  const btDrinks = [{ name: 'Gimlet', base: 'gin', rating: 5, house: false, low: false, ingredients: 'gin, lime' }];
  anthropicCalls = [];
  r = await call('/bartender', jbody({ mood: '', drinks: btDrinks }));
  const promptDry = anthropicCalls[0].body.messages[0].content;
  assert(!/WEATHER/.test(promptDry), 'no weather: the prompt is unchanged');
  anthropicCalls = [];
  r = await call('/bartender', jbody({ mood: '', drinks: btDrinks, weather: { temp: 94.6, humidity: 120, condition: 'x'.repeat(50), isEvening: 1 } }));
  const promptWet = anthropicCalls[0].body.messages[0].content;
  assert(/WEATHER RIGHT NOW: 95°F, 100% humidity/.test(promptWet), 'weather is clamped and woven into the prompt');
  assert(/after sundown/.test(promptWet) && !/x{25}/.test(promptWet), 'evening flag lands; condition is truncated');
  anthropicCalls = [];
  r = await call('/bartender', jbody({ mood: '', drinks: btDrinks, weather: { temp: 'hot' } }));
  assert(!/WEATHER/.test(anthropicCalls[0].body.messages[0].content), 'a malformed weather object is treated as absent');

  // --- /concierge: shelf-bound menu composition ---
  r = await call('/concierge', jbody({ history: [{ role: 'user', text: 'party' }], drinks: [] }));
  assert(r.status === 400, 'concierge requires a makeable list');
  anthropicCalls = [];
  anthropicReply = textReply({ reply: 'Here is a lineup.', menu: { picks: ['Gimlet', 'Imaginary Fizz', 'gimlet'], feature: 'GIMLET', featureLabel: 'the pour', theme: 'lagoon' } });
  r = await call('/concierge', jbody({ history: [{ role: 'user', text: 'taco night for six' }], drinks: btDrinks, beerWine: ['Modelo'], context: { time: 'Saturday 7:12 PM', weather: '94° and humid' } }));
  j = await r.json();
  assert(r.status === 200 && j.reply === 'Here is a lineup.', 'concierge answers');
  assert(JSON.stringify(j.menu.picks) === JSON.stringify(['Gimlet']) && j.menu.feature === 'Gimlet', 'picks are filtered to the provided list, deduped, case-healed');
  assert(j.menu.theme === 'lagoon' && j.menu.featureLabel === 'the pour', 'theme and feature label ride through');
  const ccMsgs = anthropicCalls[0].body.messages;
  assert(/HARD RULE/.test(ccMsgs[0].content) && /94° and humid/.test(ccMsgs[0].content) && /Modelo/.test(ccMsgs[0].content), 'the brief carries the rule, the night, and the beer list');
  assert(ccMsgs[ccMsgs.length - 1].content === 'taco night for six', 'the host message closes the conversation');
  assert(/serve the season/.test(ccMsgs[0].content) && /WHEN they fit the occasion/.test(ccMsgs[0].content), 'the brief demands seasonal fit — no coquito at a pool party');
  // deep-shelf cap: 81 seeds + house drinks must all reach the model
  anthropicCalls = [];
  anthropicReply = textReply({ reply: 'ok' });
  const bigList = Array.from({ length: 170 }, (_, i) => ({ name: 'Drink ' + (i + 1), base: 'gin', rating: 0, house: false, low: false, ingredients: 'x' }));
  r = await call('/concierge', jbody({ history: [{ role: 'user', text: 'big night' }], drinks: bigList }));
  const bigBrief = anthropicCalls[0].body.messages[0].content;
  assert(/"Drink 160"/.test(bigBrief) && !/"Drink 161"/.test(bigBrief), 'the drink cap admits 160 — a stocked shelf is never silently cut at 80');
  anthropicReply = textReply({ reply: 'Hmm.', menu: { picks: ['Nothing Real'] } });
  r = await call('/concierge', jbody({ history: [{ role: 'user', text: 'x' }], drinks: btDrinks }));
  j = await r.json();
  assert(j.menu === null, 'a proposal with zero real picks is withheld');

  // --- menu payload carries theme + sunset, whitelisted ---
  r = await call('/menu', jbody({ t: 'Themed', c: [{ n: 'Negroni', d: 'x', h: false }], s: [], th: 'cassis', su: 1780000000123.7 }));
  j = await r.json();
  let stored = JSON.parse(env.__store.get('m:' + j.id));
  assert(stored.th === 'cassis' && stored.su === 1780000000124, 'menu create round-trips theme + rounded sunset epoch');
  r = await call('/menu', jbody({ t: 'Bogus', c: [{ n: 'Negroni', d: 'x', h: false }], s: [], th: 'vaporwave', su: 'tonight' }));
  j = await r.json();
  stored = JSON.parse(env.__store.get('m:' + j.id));
  assert(stored.th === 'vaporwave' && stored.su === undefined, 'slug-shaped theme keys pass through (the client validates); a bogus sunset is dropped');
  r = await call('/menu', jbody({ t: 'Junk', c: [], s: [], th: 'NOT A SLUG!!' }));
  j = await r.json();
  assert(JSON.parse(env.__store.get('m:' + j.id)).th === 'golden', 'non-slug junk still falls back to golden');
  r = await call('/menu', jbody({ t: 'Tiki', c: [], s: [], th: 'lagoon' }));
  j = await r.json();
  assert(JSON.parse(env.__store.get('m:' + j.id)).th === 'lagoon', 'the new Lagoon theme rides through without a worker change ever again');

  // --- the closed flag rides the payload, literal true only ---
  r = await call('/menu', jbody({ t: 'Closed Bar', c: [], s: [], cl: true }));
  j = await r.json();
  assert(JSON.parse(env.__store.get('m:' + j.id)).cl === true, 'cl:true survives the payload whitelist');
  r = await call('/menu', jbody({ t: 'Open Bar', c: [], s: [], cl: 'yes' }));
  j = await r.json();
  assert(JSON.parse(env.__store.get('m:' + j.id)).cl === undefined, 'only a literal true closes the bar');

  // --- Web Push: VAPID identity, owner-gated subscriptions, encrypted send, pruning ---
  const { webcrypto } = require('crypto');
  const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  r = await call('/push/vapid', { method: 'GET' });
  j = await r.json();
  assert(r.status === 200 && typeof j.key === 'string' && j.key.length > 80, 'a VAPID key is minted on first ask');
  const vapidKey = j.key;
  r = await call('/push/vapid', { method: 'GET' });
  j = await r.json();
  assert(j.key === vapidKey, 'the VAPID identity persists in KV — same key every ask');

  r = await call('/menu', jbody({ t: 'Push Bar', c: [{ n: 'Negroni', d: 'x', h: false }], s: [] }));
  j = await r.json();
  const pid = j.id, powner = j.owner;
  // a REAL client keypair, so we can decrypt exactly what a phone would receive
  const ckp = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const cpubRaw = Buffer.from(await webcrypto.subtle.exportKey('raw', ckp.publicKey));
  const cauth = webcrypto.getRandomValues(new Uint8Array(16));
  const sub = { endpoint: 'https://push.test/send/abc', keys: { p256dh: b64u(cpubRaw), auth: b64u(cauth) } };
  r = await call('/menu/' + pid + '/push', { method: 'POST', headers: { authorization: 'Bearer ' + 'f'.repeat(32) }, body: JSON.stringify(sub) });
  assert(r.status === 403, 'push subscribe with the wrong owner is 403');
  r = await call('/menu/' + pid + '/push', { method: 'POST', headers: { authorization: 'Bearer ' + powner }, body: JSON.stringify(sub) });
  assert(r.status === 200 && env.__store.has('push:' + pid), 'push subscribe stores the subscription');
  r = await call('/menu/' + pid + '/push', { method: 'POST', headers: { authorization: 'Bearer ' + powner }, body: JSON.stringify(sub) });
  assert(JSON.parse(env.__store.get('push:' + pid)).length === 1, 'resubscribing the same endpoint does not duplicate');
  r = await call('/menu/' + pid + '/push', { method: 'POST', headers: { authorization: 'Bearer ' + powner }, body: JSON.stringify({ endpoint: 'http://insecure', keys: {} }) });
  assert(r.status === 400, 'a malformed subscription is refused');

  pushCalls = [];
  const ctx1 = { promises: [], waitUntil(p) { this.promises.push(p); } };
  r = await call('/menu/' + pid + '/req', jbody({ drink: 'Negroni', guest: 'Maria' }), ctx1);
  assert(r.status === 200, 'the guest request is accepted');
  await Promise.all(ctx1.promises);
  assert(pushCalls.length === 1, 'a request fires one push per subscribed phone');
  const pc = pushCalls[0];
  assert(/^vapid t=[^,]+\.[^,]+\.[^,]+, k=/.test(pc.headers.authorization), 'the push carries a VAPID JWT');
  assert(pc.headers['content-encoding'] === 'aes128gcm', 'the payload is aes128gcm-encrypted');
  // decrypt as the phone would (RFC 8291 receiver side) — proves the crypto end to end
  const body = new Uint8Array(pc.body);
  const salt = body.slice(0, 16), idlen = body[20], ephPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  assert(idlen === 65 && ephPub[0] === 4, 'header carries the ephemeral P-256 point');
  const ephKey = await webcrypto.subtle.importKey('raw', ephPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await webcrypto.subtle.deriveBits({ name: 'ECDH', public: ephKey }, ckp.privateKey, 256));
  const hk = async (s2, ikm, info, len) => {
    const k = await webcrypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await webcrypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s2, info }, k, len * 8));
  };
  const te = new TextEncoder();
  const ikm = await hk(cauth, shared, Buffer.concat([Buffer.from(te.encode('WebPush: info\0')), cpubRaw, Buffer.from(ephPub)]), 32);
  const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const aes = await webcrypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  let plain = new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, ct));
  while (plain.length && plain[plain.length - 1] === 0) plain = plain.slice(0, -1);
  assert(plain[plain.length - 1] === 2, 'the record ends with the final-record delimiter');
  const note = JSON.parse(Buffer.from(plain.slice(0, -1)).toString('utf8'));
  assert(/Negroni/.test(note.title) && /Maria/.test(note.body), 'the decrypted notification names the drink and the guest');
  assert(note.drink === 'Negroni' && note.url === './#spec=Negroni', 'the payload carries the spec deep-link for a tapped alert');

  pushStatus = 410; pushCalls = [];
  const ctx2 = { promises: [], waitUntil(p) { this.promises.push(p); } };
  await call('/menu/' + pid + '/req', jbody({ drink: 'Daiquiri' }), ctx2);
  await Promise.all(ctx2.promises);
  assert(JSON.parse(env.__store.get('push:' + pid)).length === 0, 'a gone (410) subscription is pruned');
  pushStatus = 201;
  await call('/menu/' + pid + '/push', { method: 'POST', headers: { authorization: 'Bearer ' + powner }, body: JSON.stringify(sub) });
  await call('/menu/' + pid, { method: 'DELETE', headers: { authorization: 'Bearer ' + powner } });
  assert(!env.__store.has('push:' + pid), 'revoking the menu link clears its push subscriptions too');

  console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nall green');
})();
