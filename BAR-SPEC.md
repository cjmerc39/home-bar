# BAR-SPEC.md — Home Bar Manager, v1 build spec (FINAL, amended after interview 2026-07-11)

## One-liner
A single-file, mobile-first PWA on GitHub Pages: CJ's bottle inventory + spec
book + a "what can I make right now" matcher, with a guest-facing Menu Mode,
plus an AI photo-scan that reads bottles off a shelf photo.
Sibling project to the Snap Workbench repo (C:\Users\cjmer\Projects\snap-workbench);
reuse its patterns and test style.

## AMENDMENTS from the interview (these override anything below that conflicts)
1. **NO seed bottles.** The shelf starts completely empty. Do not hardcode any
   bottle data. Delete every reference to Mijenta/Corryvreckan/etc. as seed data.
2. **Recipes ARE preloaded**: embed the ~35 canonical classics listed below on
   first launch. Do NOT include a "House Coquito" placeholder card — CJ will add
   his coquito recipe himself via the recipe form. The recipe add/edit form must
   therefore be excellent, including the `house: true` flag toggle.
3. **NEW FEATURE — AI photo scan** (see dedicated section below): photograph the
   bar, AI proposes a bottle list, user confirms/edits each row before anything
   is added to the shelf.
4. Repo name: `home-bar` (GitHub user cjmerc39, public, GitHub Pages).
5. Staples list as proposed: lime, lemon, sugar / simple syrup, honey, agave
   syrup, eggs, mint, salt, coffee/espresso, coconut cream, milk/cream.
   (User-editable in settings, matcher treats staples as always stocked.)

## Non-goals for v1 (do not build)
No cocktail-database API, no QR generation, no cost tracking, no multi-user.
(The photo-scan AI feature IS in scope per amendment 3.)

## Architecture constraints (lessons from the Workbench)
- Single `index.html` (HTML+CSS+JS inline). No build step, no framework.
- Persistence: localStorage with a versioned schema key (`bar-v1`) and a
  migration guard. Include one-tap Export JSON / Import JSON backup in
  settings — localStorage is fragile and this is the insurance.
- PWA: manifest.webmanifest + icons (180/192/512). Standalone display.
- Ship a jsdom test file (`home-bar.test.js`) mirroring the style of
  C:\Users\cjmer\Projects\snap-workbench\snap-workbench.test.js, covering:
  boot, CRUD for bottles and recipes, the matcher, unlock suggestions,
  menu mode toggle, export/import round-trip, AND the photo-scan confirm
  flow with a mocked fetch. Run: node home-bar.test.js (jsdom installed).

## Data model
```
bottle:  { id, name, category, subtype?, level: "full"|"low"|"out", notes? }
  categories: tequila, mezcal, whiskey, rum, gin, vodka, brandy, amaro,
              liqueur, vermouth, bitters, wine, mixer, other
  subtype examples: reposado, anejo, blanco (tequila); bourbon, rye, scotch,
              japanese (whiskey); aged, white, overproof (rum); sweet, dry
              (vermouth)
recipe:  { id, name, ingredients: [ing], method: "stir"|"shake"|"build"|"blend",
           glass, garnish?, notes?, rating?, house?: bool }
ing:     { qty, unit, req, note? }
  req is either { tag: {category, subtype?} } or { bottleId } or
  { staple: "lime" | ... }
staples: user-editable list of always-available items; matcher treats them
  as stocked.
```

## Matcher rules (the core feature — get this right)
- A tag req matches any bottle with level != "out" whose category matches;
  if subtype specified, bottle subtype must match it. A plain
  {category:"tequila"} matches any reposado tequila; {category:"tequila",
  subtype:"reposado"} also matches it; a blanco-only spec would not match
  a reposado.
- bottleId req matches only that bottle (level != "out").
- staple req matches if in the staples list.
- Recipe is MAKEABLE iff all ings match. Compute live, no caching bugs.
- LOW-WARNING state: makeable but ≥1 matched bottle is level "low" — show
  makeable with a subtle "running low" mark.
- UNLOCKS: for each recipe missing exactly one non-staple req, group by the
  missing tag; surface "Buy sweet vermouth → unlocks Manhattan, Negroni,
  Boulevardier (3)". Sort unlock suggestions by count desc. This list plus
  all low/out bottles = the Shopping view.

## AI photo scan (new — the marquee add flow)
- Entry point: a prominent "📷 Scan shelf" button on the Shelf view (plus in
  the empty-shelf state, which should invite it: shelf is empty on first run).
- Client flow:
  1. `<input type="file" accept="image/*" capture="environment">` — phone
     camera or gallery.
  2. Downscale client-side on a canvas to max ~1568px long edge, export JPEG
     quality ~0.8, base64-encode. (Controls API token cost + upload size.)
  3. POST JSON { media_type: "image/jpeg", data: <base64> } to SCAN_URL.
  4. Show a scanning spinner state; handle failure with a friendly retry toast.
  5. Response { bottles: [{ name, category, subtype?, level? }] } feeds a
     CONFIRMATION SHEET: one row per detected bottle with a checkbox (default
     checked), editable name, category picker, subtype field, level picker
     (default "full"). Rows the AI got wrong can be edited or unchecked.
     Duplicate detection: if a proposed name case-insensitively matches an
     existing bottle, mark the row "already on shelf" and default-uncheck it.
  6. "Add N bottles" button commits only the checked rows.
- Config: `const SCAN_URL = 'https://home-bar.cj13mercado.workers.dev/scan';`
  near the top of index.html. If SCAN_URL is empty string, hide the scan
  button entirely (graceful degradation) — manual add always works.
- Testable: the confirm-sheet logic must be exercised in home-bar.test.js by
  mocking fetch to return a canned bottle list.

## Cloudflare Worker (`home-bar-worker.js`, committed to the repo)
Model it on C:\Users\cjmer\Projects\snap-workbench\snap-workbench-worker.js
(same CORS envelope, ALLOWED_ORIGIN env var, json() helper, deploy-by-paste
comments at the top). Endpoints:
- OPTIONS: CORS preflight.
- POST /scan: body { media_type, data }. Validate: media_type must be
  image/jpeg|png|webp; data base64, reject > ~8MB. Calls the Anthropic
  Messages API (https://api.anthropic.com/v1/messages, x-api-key from env
  secret ANTHROPIC_API_KEY, anthropic-version: 2023-06-01) with:
  - model: "claude-opus-4-8"
  - max_tokens: 4000
  - messages: one user turn, content = [image block (type:"image",
    source:{type:"base64", media_type, data}), text block instructing: identify
    every liquor/spirit/liqueur/vermouth/bitters/mixer bottle visible; give
    exact brand + expression when legible; categorize into exactly these
    categories: tequila, mezcal, whiskey, rum, gin, vodka, brandy, amaro,
    liqueur, vermouth, bitters, wine, mixer, other; optional subtype
    (reposado/anejo/blanco/bourbon/rye/scotch/japanese/aged/white/overproof/
    sweet/dry etc.); skip glassware/decor; if a label is unreadable, include
    it with best-guess name and note uncertainty in the name like "(unsure)".]
  - output_config: { format: { type: "json_schema", schema: { type:"object",
    properties:{ bottles:{ type:"array", items:{ type:"object", properties:{
    name:{type:"string"}, category:{type:"string", enum:[...the 14 categories]},
    subtype:{type:"string"} }, required:["name","category"],
    additionalProperties:false } } }, required:["bottles"],
    additionalProperties:false } } }
  Parse the first text block as JSON, return { bottles } with CORS headers.
  On upstream error return { error } with status 502; never leak the API key.
- Deployment is manual paste into the Cloudflare dashboard (CJ already has an
  account with the snap-workbench worker + ANTHROPIC_API_KEY pattern). Include
  step-by-step deploy comments at the top of the worker file.

## Views (bottom tab bar, 4 tabs)
1. **Shelf** — bottle grid/list grouped by category; tap cycles level
   full→low→out with distinct visual states; add/edit sheet; search;
   the Scan shelf button. Empty state invites scanning or manual add.
2. **Specs** — recipe cards (name, spirit chips, rating stars); filter chips
   by base spirit + "makeable only" toggle; tap → detail sheet with full
   spec, notes editing, house flag; add/edit recipe form (ingredient rows
   with tag/bottle/staple picker, qty+unit).
3. **Tonight** — the payoff screen: Makeable Now list sorted by rating,
   low-warnings marked; below it, the Unlocks section; below that, Shopping
   list (low/out bottles).
4. **Menu** — guest mode: strips ALL admin chrome. Big serif type, drink
   name + one-line description (auto from ingredients or the notes field),
   only makeable recipes, house drinks pinned to top with a ★. A small
   discreet exit control returns to admin. This view should look like a
   printed menu, not an app.

## Seed data
- Bottles: NONE (amendment 1).
- Recipes: embed these ~35 canonical classics with standard, widely accepted
  specs (recipes are uncopyrightable facts): Old Fashioned, Manhattan,
  Whiskey Sour, Gold Rush, Penicillin, Paper Plane, Boulevardier, Sazerac,
  Highball (Japanese style), Margarita, Tommy's Margarita, Paloma, Ranch
  Water, Oaxaca Old Fashioned, Daiquiri, Mojito, Mai Tai, Dark 'n Stormy,
  Jungle Bird, Piña Colada, Hemingway Daiquiri, Corn 'n Oil, Negroni,
  Martini, Gimlet, Last Word, Tom Collins, French 75, Aperol Spritz,
  Amaretto Sour, Espresso Martini, Naked & Famous, Black Manhattan,
  Rum Old Fashioned. Use tag reqs (category/subtype) + staples so the
  matcher works the moment bottles are added. Bitters/vermouth/liqueur
  ingredients are tag reqs (they're bottles, not staples). Where a liqueur
  is highly specific, use category "liqueur" with a subtype naming it
  (e.g. subtype "orange" for Cointreau/triple sec, "maraschino", "green
  chartreuse", "yellow chartreuse", "amaretto", "coffee", "falernum",
  "campari" under amaro or its own convention — be consistent and make the
  subtype picker in the bottle form suggest these so scanned/added bottles
  match recipes).
- No House Coquito card (amendment 2).

## Design direction (explicitly NOT the Snap Workbench look)
Back-bar at golden hour: deep walnut/near-black backgrounds (#1a1410 family),
warm amber and cream text, brass accent (#c9a15a family) for actions and the
house ★. Display serif via Google Fonts (Playfair Display or Cormorant
Garamond) for headings and all of Menu Mode; humanist sans for admin body.
Subtle grain or vignette welcome; no neon, no gradients-as-personality.
Icons: a coupe glass mark in brass on walnut for the PWA icon set (generate
PNGs 180/192/512 programmatically, e.g. with a small node script using
canvas-free SVG→PNG or hand-built pixel data; committed binaries are fine).

## Acceptance checklist
- [ ] Cycle a bottle to "out" → dependent recipes leave Makeable instantly
- [ ] {tag: tequila/reposado} spec matches a bottle categorized tequila/reposado
- [ ] Unlocks correctly counts multi-recipe single-missing-ingredient groups
- [ ] Menu Mode shows only makeable + pins house drinks, zero admin UI
- [ ] Export → wipe localStorage → Import restores everything
- [ ] Scan flow: mocked fetch → confirm sheet → checked rows added, unchecked not
- [ ] SCAN_URL empty → scan button hidden, everything else works
- [ ] All jsdom tests green (node home-bar.test.js after npm i jsdom)

## v2 parking lot (do not build now)
AI bartender ("what should I make tonight?"); QR for Menu Mode; party/batch
scaling; tasting journal; coquito season countdown.
