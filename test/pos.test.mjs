import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture} from './fixture.mjs';
import {calculateSale,minor,proportion} from '../src/domain.js';
import {invoke} from '../src/pos.js';

test('two owners cannot read, edit, rotate or reconcile each other’s data',()=>{
  const h=fixture(),a=h.create(),sale=h.pos.createCheckout(h.sale(a));
  h.owner='bob'; const b=h.create();
  assert.deepEqual(h.pos.listTerminals().map(t=>t.id),[b.id]);
  for (const run of [()=>h.pos.saveTerminal({...h.input(),id:a.id}),()=>h.pos.disableTerminal({id:a.id}),()=>h.pos.rotateLinks({id:a.id}),()=>h.pos.sales({id:a.id}),()=>h.pos.reconcile({id:b.id,checkout_id:sale.id}),()=>h.pos.getTerminal({link:a.cashier_link})]) assert.throws(run);
  assert.throws(()=>h.create({wallet:'alice_lightning'}));
  assert.throws(()=>h.create({tip_wallet:'alice_tips'}));
});

test('same-owner terminals cannot read each other’s checkout',()=>{
  const h=fixture(),a=h.create(),b=h.create(),c=h.pos.createCheckout(h.sale(a));
  assert.throws(()=>h.pos.checkoutStatus({link:b.cashier_link,checkoutId:c.id}));
  assert.equal(h.pos.publicHistory({link:b.cashier_link}).length,0);
});

test('terminal details remain private and lists omit full catalogs',()=>{
  const h=fixture(),t=h.create();
  assert.equal(h.pos.listTerminals()[0].product_count,1);
  assert.equal(h.pos.listTerminals()[0].products,undefined);
  assert.equal(h.pos.terminalSettings({id:t.id}).products.length,1);
  h.owner='bob';assert.throws(()=>h.pos.terminalSettings({id:t.id}));
});

test('paid events use the core source wallet binding when an owned wallet is an alias',()=>{
  const h=fixture(),t=h.create(),c=h.pos.createCheckout(h.sale(t));h.markPaid(c.payment_hash);
  const e=h.event(c.payment_hash);e.walletId='source_wallet';e.payment.extension_context.wallet_id='source_wallet';
  assert.deepEqual(h.pos.recordPayment(e),{recorded:true});
});

test('display is read-only and limited to the latest checkout',()=>{
  const h=fixture(),t=h.create({remote_enabled:true}),a=h.pos.createCheckout(h.sale(t));
  assert.throws(()=>h.pos.createCheckout(h.sale(t,{link:t.display_link})));
  assert.throws(()=>h.pos.publicHistory({link:t.display_link}));
  h.clock+=3; const b=h.pos.createCheckout(h.sale(t,{action_id:'action_67890'}));
  assert.throws(()=>h.pos.checkoutStatus({link:t.display_link,checkoutId:a.id}));
  assert.equal(h.pos.getTerminal({link:t.display_link}).latest.id,b.id);
});

test('disabled terminals and rotated links fail closed',()=>{
  const h=fixture(),t=h.create({remote_enabled:true});
  const next=h.pos.rotateLinks({id:t.id});
  assert.throws(()=>h.pos.getTerminal({link:t.cashier_link}));
  assert.throws(()=>h.pos.getTerminal({link:t.display_link}));
  assert.equal(h.pos.getTerminal({link:next.cashier_link}).name,'Cafe');
  h.pos.disableTerminal({id:t.id});
  assert.throws(()=>h.pos.getTerminal({link:next.cashier_link}));
});

test('public projections contain no wallet IDs, payout destinations or share keys',()=>{
  const h=fixture(),t=h.create({tips_enabled:true,tip_wallet:'alice_tips',revenue_address:'merchant@example.com',revenue_percent:10});
  const c=h.pos.createCheckout(h.sale(t,{tip:'10'}));
  const output=JSON.stringify([h.pos.getTerminal({link:t.cashier_link}),c,h.pos.publicHistory({link:t.cashier_link})]);
  for (const secret of ['alice_lightning','alice_tips','merchant@example.com',t.display_link,t.id]) assert.equal(output.includes(secret),false);
});

test('server rejects forged totals, wallets, product IDs and disabled price overrides',()=>{
  const h=fixture(),t=h.create({allow_price_adjustment:false});
  const c=h.pos.createCheckout(h.sale(t,{wallet:'bob_lightning',amount_sat:1,total_minor:1}));
  assert.equal(c.amount_sat,100);
  assert.throws(()=>h.pos.createCheckout(h.sale(t,{items:[{product_id:'product_01',quantity:1,price:'1'}]})));
  assert.throws(()=>h.pos.createCheckout(h.sale(t,{items:[{product_id:'missing_id',quantity:1}]})));
});

test('checkout retries reuse the original invoice and reject changed carts',()=>{
  const h=fixture(),t=h.create(),input=h.sale(t),a=h.pos.createCheckout(input),b=h.pos.createCheckout(input);
  assert.equal(a.id,b.id); assert.equal(h.invoices.size,1);
  assert.throws(()=>h.pos.createCheckout({...input,items:[{product_id:'product_01',quantity:2}]}));
});

test('uncertain invoice creation never creates a second invoice on retry',()=>{
  const h=fixture(),t=h.create(),input=h.sale(t); h.loseInvoice=true;
  assert.throws(()=>h.pos.createCheckout(input),/not confirmed/);
  h.loseInvoice=false;
  assert.equal(h.pos.createCheckout(input).status,'creating');
  assert.equal(h.invoices.size,1);
});

test('trusted paid event recovers early settlement after lost invoice response',()=>{
  const h=fixture(),t=h.create(),input=h.sale(t); h.loseInvoice=true;
  assert.throws(()=>h.pos.createCheckout(input));
  const hash=[...h.invoices.keys()][0]; h.markPaid(hash);
  h.pos.recordPayment(h.event(hash));
  assert.equal(h.pos.createCheckout(input).status,'paid');
});

test('forged or pending events cannot mark an unpaid checkout paid',()=>{
  const h=fixture(),t=h.create(),c=h.pos.createCheckout(h.sale(t)),e=h.event(c.payment_hash);
  h.pos.recordPayment(e);
  assert.equal(h.pos.checkoutStatus({link:t.cashier_link,checkoutId:c.id}).status,'pending');
  assert.deepEqual(h.pos.recordPayment({...e,extension:'other'}),{ignored:true});
  assert.deepEqual(h.pos.recordPayment({...e,walletId:'bob_lightning'}),{ignored:true});
  assert.deepEqual(h.pos.recordPayment({...e,pending:true}),{ignored:true});
});

test('wrong paid amount fails validation',()=>{
  const h=fixture(),t=h.create(),c=h.pos.createCheckout(h.sale(t));
  h.markPaid(c.payment_hash); h.invoices.get(c.payment_hash).amount=1000;
  assert.throws(()=>h.pos.checkoutStatus({link:t.cashier_link,checkoutId:c.id}),/amount/);
  assert.equal(h.payments.length,0);
});

test('duplicate events and polls send each configured share at most once',()=>{
  const h=fixture(),t=h.create({tips_enabled:true,tip_wallet:'alice_tips',revenue_address:'owner@example.com',revenue_percent:10});
  const c=h.pos.createCheckout(h.sale(t,{tip:'20'})); h.markPaid(c.payment_hash);
  h.pos.recordPayment(h.event(c.payment_hash)); h.pos.recordPayment(h.event(c.payment_hash));
  h.pos.checkoutStatus({link:t.cashier_link,checkoutId:c.id});
  assert.deepEqual(h.payments.map(p=>p.amount),[20,10]);
});

for (const state of ['pending','throws']) test(`uncertain ${state} payout is never automatically resent`,()=>{
  const h=fixture(),t=h.create({tips_enabled:true,tip_wallet:'alice_tips'});
  h.payPending=state==='pending'; h.payThrows=state==='throws';
  const c=h.pos.createCheckout(h.sale(t,{tip:'20'})); h.markPaid(c.payment_hash);
  h.pos.checkoutStatus({link:t.cashier_link,checkoutId:c.id});
  h.pos.recordPayment(h.event(c.payment_hash));
  assert.equal(h.payments.length,1);
  assert.equal(h.pos.sales({id:t.id}).rows[0].payouts.tip.state,state==='pending'?'pending':'review');
});

test('fiat checkout uses saved wallet/provider and retains tips in the fiat wallet',()=>{
  const h=fixture(),t=h.create({currency:'USD',provider:'stripe',fiat_wallet:'alice_fiat',tips_enabled:true,tip_wallet:'alice_tips',products:[{id:'product_01',title:'Coffee',price:'2.50'}]});
  const c=h.pos.createCheckout(h.sale(t,{method:'fiat',tip:'0.50',provider:'evil',wallet:'bob_fiat'}));
  assert.match(c.payment_request,/^https:\/\/checkout.example/);
  const row=h.host.db.get('checkouts',c.id); assert.equal(row.wallet,'alice_fiat'); assert.equal(row.provider,'stripe');
  h.markPaid(c.payment_hash); h.pos.recordPayment(h.event(c.payment_hash)); assert.equal(h.payments.length,0);
});

test('tax, tips and currency precision are calculated without trusting client totals',()=>{
  const h=fixture(),t=h.create({currency:'USD',tax_default:20,tax_inclusive:false,tips_enabled:true,products:[{id:'product_01',title:'Coffee',price:'2.50'}]});
  let sale=calculateSale(t,{items:[{product_id:'product_01',quantity:2}],tip:'1.00'});
  assert.equal(sale.total_minor,700); assert.equal(sale.tax_minor,100);
  sale=calculateSale({...t,tax_inclusive:true},{items:[{product_id:'product_01',quantity:2}],tip:'0'});
  assert.equal(sale.total_minor,500); assert.equal(sale.tax_minor,83);
  for (const value of ['NaN','Infinity','-1','1e3','0.001']) assert.throws(()=>minor(value,'USD'));
  assert.equal(minor('12.345','KWD'),12345); assert.throws(()=>minor('1.5','JPY'));
});

test('oversized, malformed and disabled catalog input is rejected',()=>{
  const h=fixture();
  for (const p of [{price:'-1'},{tax:101},{image:'https://external.example/image.png'},{title:'x'.repeat(81)}]) assert.throws(()=>h.create({products:[{id:'product_01',title:'Coffee',price:'100',...p}]}));
  const t=h.create({products:[{id:'product_01',title:'Coffee',price:'100',disabled:true}]});
  assert.throws(()=>h.pos.createCheckout(h.sale(t)));
});

test('unexpected host errors are redacted at the export boundary',()=>{
  const result=JSON.parse(invoke({metadata(){throw Error('secret-account-token');}},'metadata','{}'));
  assert.equal(result.ok,false); assert.equal(JSON.stringify(result).includes('secret-account-token'),false);
});

test('every public route resolves a source owner, every mutating export shares a lock',()=>{
  const c=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
  for(const r of c.api_routes.filter(r=>r.auth==='public')) assert.deepEqual(r.ownerContext,{table:'links',idParam:'link'});
  for(const e of c.wasm.exports) assert.equal(e.sync,true);
  assert.equal(c.api_routes.some(r=>r.export==='record-payment'),false);
});

test('owner refresh checks its saved wallet and leaves payouts for grant-controlled contexts',()=>{
  const h=fixture(),t=h.create({tips_enabled:true,tip_wallet:'alice_tips'}),c=h.pos.createCheckout(h.sale(t,{tip:'20'}));
  h.host.refreshPayment=(wallet,hash)=>{assert.equal(wallet,'alice_lightning');assert.equal(hash,c.payment_hash);h.markPaid(hash);};
  assert.equal(h.pos.reconcile({id:t.id,checkout_id:c.id,wallet:'bob_lightning'}).status,'paid');
  assert.equal(h.payments.length,0);
  h.pos.recordPayment(h.event(c.payment_hash));assert.equal(h.payments.length,1);
});

test('large monetary proportions use exact integer rounding',()=>{
  assert.equal(proportion(999999999999,9999,10000,true),999899999999);
  assert.equal(proportion(999999999,99999999999,999999999999),99999999);
  assert.equal(proportion(1,1,2,true),1);
  assert.equal(proportion(1,1,2),0);
});

test('catalog size is limited in bytes, including multibyte text',()=>{
  const h=fixture();
  const products=Array.from({length:100},(_,i)=>({id:`product_${String(i).padStart(3,'0')}`,title:'茶'.repeat(70),description:'茶'.repeat(200),price:'100'}));
  assert.throws(()=>h.create({products}),/Catalog is too large/);
});
