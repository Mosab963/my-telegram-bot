// MUSE provider client (DigiShop bot API). Trial integration, phase 1.
//
// Confirmed live (read-only calls, Nov 28 2026):
//   base URL  https://digi-shop-bot.up.railway.app/api
//   auth      Authorization: Bearer <key>   (x-api-key and ?api_key= also work)
//   GET  /products -> {ok, products:[{id,name,price,stock,available,description,note}]}
//   GET  /balance  -> {ok, balance}          (USDT, shared wallet with the provider bot)
//   POST /order    -> body {product_id, quantity, request_id}; request_id = idempotency key
//
// Env vars:
//   MUSE_API_KEY   provider key (set it in Vercel yourself, never commit it)
//   MUSE_API_URL   optional, defaults to the base URL above
//   MUSE_ENABLED   must be "1" for any automatic fulfilment. Anything else = old manual flow.
//   MUSE_MAP       optional JSON string that overrides ./muse-map.json

const DEFAULT_URL = 'https://digi-shop-bot.up.railway.app/api';
const TIMEOUT_MS = 20000;

function cfg() {
    return {
        url: String(process.env.MUSE_API_URL || DEFAULT_URL).replace(/\/+$/, ''),
        key: process.env.MUSE_API_KEY || '',
        enabled: process.env.MUSE_ENABLED === '1' && !!process.env.MUSE_API_KEY
    };
}

async function call(method, route, body) {
    const c = cfg();
    if (!c.key) return { ok: false, status: 0, error: 'MUSE_API_KEY not set', network: false };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(c.url + route, {
            method,
            headers: { Authorization: 'Bearer ' + c.key, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
            signal: ctrl.signal
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        return { ok: res.ok && !(json && json.ok === false), status: res.status, json, text, network: false };
    } catch (e) {
        // Timeout or network drop: the provider may or may not have processed it.
        return { ok: false, status: 0, error: String(e && e.message || e), network: true };
    } finally { clearTimeout(timer); }
}

async function getBalance() {
    const r = await call('GET', '/balance');
    if (r.ok && r.json && typeof r.json.balance === 'number') return { ok: true, balance: r.json.balance };
    return { ok: false, error: r.error || (r.json && r.json.error) || ('HTTP ' + r.status) };
}

let productCache = { at: 0, list: null };
async function getProducts(force) {
    if (!force && productCache.list && Date.now() - productCache.at < 60000) return { ok: true, products: productCache.list };
    const r = await call('GET', '/products');
    if (r.ok && r.json && Array.isArray(r.json.products)) {
        productCache = { at: Date.now(), list: r.json.products };
        return { ok: true, products: r.json.products };
    }
    return { ok: false, error: r.error || (r.json && r.json.error) || ('HTTP ' + r.status) };
}

// ---- Service mapping --------------------------------------------------
// muse-map.json: { "<store service id or exact title>": { "productId": 3, "sellUsd": 3.5 } }
// sellUsd is what the customer pays in USD. Provider cost is read live from /products,
// so the cost always matches the provider's current price. No entry = manual flow.
function loadMap() {
    try {
        if (process.env.MUSE_MAP) return JSON.parse(process.env.MUSE_MAP);
        return require('./muse-map.json'); // static require so Vercel bundles it
    } catch (_) { return {}; }
}
function findMapping(order) {
    const map = loadMap();
    return map[order.serviceId] || map[order.serviceTitle] || null;
}

// Decide if an approved order can be fulfilled automatically.
// Returns { auto:false, reason } to fall back to the manual flow, or { auto:true, mapping, product }.
async function checkAutoFulfil(order) {
    const c = cfg();
    if (!c.enabled) return { auto: false, reason: 'disabled' };
    const mapping = findMapping(order);
    if (!mapping || !mapping.productId) return { auto: false, reason: 'no_mapping' };
    const p = await getProducts();
    if (!p.ok) return { auto: false, reason: 'products_unreachable: ' + p.error };
    const product = p.products.find((x) => String(x.id) === String(mapping.productId));
    if (!product) return { auto: false, reason: 'product_missing' };
    if (!product.available || !(product.stock > 0)) return { auto: false, reason: 'out_of_stock' };
    const cost = Number(product.price);
    const sell = Number(mapping.sellUsd);
    if (!(sell > 0) || sell < cost) return { auto: false, reason: `below_cost (sell ${sell} < cost ${cost})` };
    const b = await getBalance();
    if (!b.ok) return { auto: false, reason: 'balance_unreachable: ' + b.error };
    if (b.balance < cost) return { auto: false, reason: `low_balance (${b.balance} < ${cost})` };
    return { auto: true, mapping, product, cost, balance: b.balance };
}

// ---- ORDER ADAPTER (shape confirmed from the provider's own API docs) -----
// POST /order  { "product_id": 123, "quantity": 1, "request_id": "<unique string>" }
// request_id is the idempotency key: reusing it returns the original result and never
// charges twice. The wallet is charged only on actual delivery. We send our internal
// order id, so a retry of the same order is always safe, even after a timeout.
// Delivered items come back in the JSON response. The exact field name is not
// documented, so common names are tried; if none match, the caller forwards the raw
// response to the admin so nothing paid for is lost.
async function placeOrder(order, mapping) {
    const r = await call('POST', '/order', {
        product_id: Number(mapping.productId),
        quantity: 1,
        request_id: String(order.id)
    });
    if (r.network) return { ok: false, retrySafe: true, error: r.error };
    if (r.status >= 500) return { ok: false, retrySafe: true, error: 'HTTP ' + r.status };
    const j = r.json || {};
    if (!r.ok) return { ok: false, retrySafe: true, error: j.error || j.message || ('HTTP ' + r.status), raw: r.text };
    const o = j.order || {};
    const d = o.delivered_items || o.delivered_item || o.items || o.delivery || o.data || j.delivered_items || j.delivered_item || j.items || j.delivery || j.data || null;
    const text = d == null ? null : (typeof d === 'string' ? d : (Array.isArray(d) && d.every((x) => typeof x === 'string') ? d.join('\n') : JSON.stringify(d, null, 2)));
    return { ok: true, deliveredText: text, raw: r.text, providerOrderId: o.id || o.order_id || j.order_id || null };
}

module.exports = { cfg, getBalance, getProducts, findMapping, checkAutoFulfil, placeOrder };
