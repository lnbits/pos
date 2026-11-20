// All monetary calculations are validated on the server. Browser totals are previews.
export class InputError extends Error {}

export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an object.');
  return value;
}

export function text(value, name, max = 120, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`Invalid ${name}.`);
  return value.trim();
}

export function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) fail('Invalid identifier.');
  return value;
}

export function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${name}.`);
  return value;
}

export function digits(currency) {
  if (currency === 'sat') return 0;
  if (['BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF'].includes(currency)) return 0;
  if (['BHD','IQD','JOD','KWD','LYD','OMR','TND'].includes(currency)) return 3;
  if (['CLF','UYW'].includes(currency)) return 4;
  return 2;
}

export function minor(value, currency) {
  const s = String(value);
  const places = digits(currency);
  if (!/^\d{1,10}(\.\d{1,4})?$/.test(s)) fail('Enter a valid positive price.');
  const [whole, fraction = ''] = s.split('.');
  if (fraction.length > places) fail(`Use at most ${places} decimal places.`);
  return integer(Number(whole) * 10 ** places + Number(fraction.padEnd(places, '0')), 'price', 0, 1e12);
}

export function decimal(value, currency) {
  const places = digits(currency);
  return (value / 10 ** places).toFixed(places);
}

export function percent(value, name = 'tax') {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0 || n > 100 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-7) fail(`Invalid ${name}.`);
  return Math.round(n * 100);
}

export function proportion(amount, numerator, denominator, nearest = false) {
  const divisor = BigInt(denominator);
  return Number((BigInt(amount) * BigInt(numerator) + (nearest ? divisor / 2n : 0n)) / divisor);
}

export function normalizeTerminal(input, currencies, wallets) {
  object(input);
  const currency = input.currency === 'sat' ? 'sat' : text(input.currency, 'currency', 3, true).toUpperCase();
  if (currency !== 'sat' && !currencies.includes(currency)) fail('Unsupported currency.');
  const ownWallet = (id, required) => {
    if (!id && !required) return '';
    if (!wallets.some(w => w.id === id)) fail('Select one of your wallets.');
    return id;
  };
  const wallet = ownWallet(input.wallet, true);
  const tipWallet = ownWallet(input.tip_wallet, false);
  const provider = text(input.provider, 'provider', 30);
  const fiatWallet = provider ? ownWallet(input.fiat_wallet, true) : '';
  if (provider && (currency === 'sat' || wallets.find(w => w.id === fiatWallet)?.currency?.toUpperCase() !== currency)) fail('Select a receiving wallet in the terminal currency.');
  const revenueAddress = text(input.revenue_address, 'Lightning address', 254);
  if (revenueAddress && !/^[^\s@]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(revenueAddress)) fail('Enter a Lightning address.');
  const tips = input.tip_options ?? [10,15,20];
  if (!Array.isArray(tips) || tips.length > 8) fail('Use up to eight tip percentages.');
  const products = input.products ?? [];
  if (!Array.isArray(products) || products.length > 100) fail('Use up to 100 products.');
  const seen = new Set();
  const normalized = products.map(p => {
    object(p);
    const id = identifier(p.id);
    if (seen.has(id)) fail('Product IDs must be unique.');
    seen.add(id);
    const price = minor(p.price, currency);
    if (!price) fail('Product price must be positive.');
    const image = text(p.image, 'image', 8192);
    if (image && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) fail('Use a small PNG, JPEG or WebP data image.');
    return {id, title:text(p.title,'product title',80,true), description:text(p.description,'description',240), category:text(p.category,'category',40), price:decimal(price,currency), tax:p.tax == null || p.tax === '' ? null : percent(p.tax)/100, disabled:p.disabled === true, image};
  });
  const result = {
    name:text(input.name,'terminal name',80,true), currency, wallet, tip_wallet:tipWallet,
    fiat_wallet:fiatWallet, provider, tax_inclusive:input.tax_inclusive !== false,
    tax_default:percent(input.tax_default)/100, allow_price_adjustment:input.allow_price_adjustment !== false,
    tips_enabled:input.tips_enabled === true, tip_options:tips.map(n => percent(n,'tip percentage')/100),
    revenue_address:revenueAddress, revenue_percent:revenueAddress ? percent(input.revenue_percent,'revenue percentage')/100 : 0,
    business_name:text(input.business_name,'business name',120), business_address:text(input.business_address,'business address',300),
    business_vat_id:text(input.business_vat_id,'VAT ID',80), only_show_sats_on_bitcoin:input.only_show_sats_on_bitcoin !== false,
    remote_enabled:input.remote_enabled === true, products:normalized
  };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 48000) fail('Catalog is too large. Reduce images or products.');
  return result;
}

export function calculateSale(terminal, input) {
  object(input);
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) fail('Add between 1 and 100 cart lines.');
  const lines = input.items.map(line => {
    object(line);
    const quantity = integer(line.quantity, 'quantity', 1, 999);
    const product = line.product_id ? terminal.products.find(p => p.id === line.product_id && !p.disabled) : null;
    if (line.product_id && !product) fail('Product is unavailable.');
    const catalogPrice = product ? minor(product.price, terminal.currency) : null;
    const price = line.price == null && product ? catalogPrice : minor(line.price, terminal.currency);
    if (!price) fail('Price must be positive.');
    if (product && !terminal.allow_price_adjustment && price !== catalogPrice) fail('Price adjustment is disabled.');
    const taxRate = percent(product?.tax ?? terminal.tax_default);
    const subtotal = integer(price * quantity,'line total',1,1e12);
    const tax = proportion(subtotal, taxRate, terminal.tax_inclusive ? 10000 + taxRate : 10000, true);
    return {product_id:product?.id || '', title:product?.title || text(line.title,'item title',80,true), note:text(line.note,'item note',160), quantity, price_minor:price, subtotal_minor:subtotal, tax_minor:tax};
  });
  const subtotal = lines.reduce((s,l)=>s+l.subtotal_minor,0);
  const tax = lines.reduce((s,l)=>s+l.tax_minor,0);
  const base = integer(subtotal + (terminal.tax_inclusive ? 0 : tax),'sale total',1,1e12);
  const tip = terminal.tips_enabled ? minor(input.tip || '0',terminal.currency) : 0;
  if (!terminal.tips_enabled && Number(input.tip || 0) !== 0) fail('Tips are disabled.');
  if (tip > base) fail('Tip cannot exceed the sale amount.');
  return {items:lines,currency:terminal.currency,subtotal_minor:subtotal,tax_minor:tax,tax_inclusive:terminal.tax_inclusive,tip_minor:tip,total_minor:integer(base+tip,'sale total',1,1e12),note:text(input.note,'sale note',240)};
}

export function publicTerminal(t) {
  const {name,currency,tax_inclusive,tax_default,allow_price_adjustment,tips_enabled,tip_options,products,business_name,business_address,business_vat_id,only_show_sats_on_bitcoin} = t;
  return {name,currency,tax_inclusive,tax_default,allow_price_adjustment,tips_enabled,tip_options,products,business_name,business_address,business_vat_id,only_show_sats_on_bitcoin,fiat_enabled:!!t.provider};
}

export function fail(message) { throw new InputError(message); }
