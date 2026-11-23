import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.mjs';
import {invoke} from '../src/pos.js';

function setup(overrides={}) {
  const h=fixture();
  const t=h.create({onchain_enabled:true,onchain_wallet_id:'alice_onchain',...overrides});
  const input=h.sale(t,{method:'onchain'});
  const status=c=>h.pos.checkoutStatus({link:t.cashier_link,checkoutId:c.id});
  return {h,t,input,status};
}

test('on-chain settings accept only an owned ready wallet of the correct type',()=>{
  const h=fixture();
  for(const wallet of ['bob_onchain','alice_lightning','alice_fiat',''])assert.throws(()=>h.create({onchain_enabled:true,onchain_wallet_id:wallet}));
  assert.throws(()=>h.create({wallet:'alice_onchain'}));
  h.onchainReady=false;
  assert.throws(()=>h.create({onchain_enabled:true,onchain_wallet_id:'alice_onchain'}),/ready/);
  const legacy=h.create();
  assert.equal(legacy.onchain_enabled,false);
  assert.equal(legacy.onchain_zero_conf,false);
  assert.throws(()=>h.pos.createCheckout(h.sale(legacy,{method:'onchain'})),/unavailable/);
});

test('wallet metadata stays owned and includes network and readiness',()=>{
  const h=fixture();
  const wallets=h.pos.metadata().wallets;
  assert.equal(wallets.find(w=>w.id==='alice_onchain').receiving_ready,true);
  assert.equal(wallets.find(w=>w.id==='alice_onchain').onchain_network,'Regtest');
  h.owner='bob';
  assert.ok(h.pos.metadata().wallets.every(w=>w.id.startsWith('bob_')));
});

test('reservation uses the saved checkout binding and server amount; retries reuse it',()=>{
  const {h,t,input}=setup();
  const forged={...input,wallet:'bob_onchain',source_id:'other-terminal',amount_sat:1,onchain_zero_conf:true};
  const c=h.pos.createCheckout(forged);
  assert.equal(c.method,'onchain');
  assert.equal(c.status,'pending');
  assert.equal(c.amount_sat,100);
  assert.equal(c.onchain.zero_conf,false);
  assert.equal(c.payment_request,`bitcoin:${c.onchain.address}?amount=0.00000100`);
  assert.equal(h.reservations[0].walletId,'alice_onchain');
  assert.equal(h.reservations[0].sourceId,t.id);
  assert.equal(h.reservations[0].checkoutId,c.id);
  assert.deepEqual(h.pos.createCheckout(input),c);
  assert.deepEqual(h.pos.createCheckout({...input,items:[{quantity:1,product_id:'product_01',ignored:'extra data'}]}),c);
  assert.equal(h.reservations.length,1);
  assert.equal(h.invoices.size,0);
  assert.throws(()=>h.pos.createCheckout({...input,method:'lightning'}),/retry/);
  assert.throws(()=>h.pos.createCheckout({...input,items:[{product_id:'product_01',quantity:2}]}),/retry/);
});

test('different checkouts receive different addresses',()=>{
  const {h,input}=setup();
  const first=h.pos.createCheckout(input);
  h.clock+=3;
  const second=h.pos.createCheckout({...input,action_id:'action_other'});
  assert.notEqual(first.onchain.address,second.onchain.address);
});

for(const failure of ['allocation response','receipt save'])test(`uncertain ${failure} never allocates again or exposes an unsaved address`,()=>{
  const {h,input}=setup();
  if(failure==='allocation response')h.loseReservation=true;
  else {
    const save=h.host.db.set;
    h.host.db.set=(table,row)=>{if(table==='checkouts'&&row.status==='pending')throw Error('lost save');return save(table,row);};
  }
  assert.throws(()=>h.pos.createCheckout(input),/not confirmed/);
  const retry=h.pos.createCheckout(input);
  assert.equal(retry.status,'creating');
  assert.equal(retry.payment_request,'');
  assert.equal(retry.onchain,null);
  assert.equal(h.reservations.length,1);
});

test('underpayment and unconfirmed funding stay pending until the saved threshold is met',()=>{
  const {h,input,status}=setup();
  const c=h.pos.createCheckout(input);
  for(const [confirmed,unconfirmed] of [[0,0],[50,0],[0,100],[99,20]]){
    h.onchainTotals={receivedSat:BigInt(confirmed+unconfirmed),confirmedSat:BigInt(confirmed),unconfirmedSat:BigInt(unconfirmed)};
    const pending=status(c);
    assert.equal(pending.status,'pending');
    assert.equal(pending.onchain.received_sat,confirmed+unconfirmed);
    assert.equal(pending.onchain.confirmed_sat,confirmed);
  }
  h.onchainTotals={receivedSat:120n,confirmedSat:100n,unconfirmedSat:20n};
  assert.equal(status(c).status,'paid');
  assert.equal(h.payments.length,0);
});

test('zero-confirmation is explicit; on-chain tips and revenue never trigger Lightning spending',()=>{
  const {h,input,status}=setup({onchain_zero_conf:true,tips_enabled:true,tip_wallet:'alice_tips',revenue_address:'merchant@example.com',revenue_percent:10});
  const c=h.pos.createCheckout({...input,tip:'20'});
  h.onchainTotals={receivedSat:120n,confirmedSat:0n,unconfirmedSat:120n};
  assert.equal(status(c).status,'paid');
  assert.equal(h.payments.length,0);
  assert.equal(h.invoices.size,0);
});

test('settings edits do not change a saved checkout address, amount or confirmation rule',()=>{
  const {h,t,input,status}=setup({currency:'USD',products:[{id:'product_01',title:'Coffee',price:'1.23'}]});
  const c=h.pos.createCheckout(input);
  h.pos.saveTerminal({...t,onchain_enabled:false,onchain_zero_conf:true,products:[{id:'product_01',title:'Coffee',price:'2.50'}]});
  h.host.rate=()=>({rate:9999});
  assert.deepEqual(h.pos.createCheckout(input),c);
  h.onchainTotals={receivedSat:1230n,confirmedSat:0n,unconfirmedSat:1230n};
  assert.equal(status(c).status,'pending');
  assert.equal(h.reservations.length,1);
});

test('failed or invalid core scans fail closed, preserve the QR and recover without reserving again',()=>{
  const {h,input,status}=setup();
  const c=h.pos.createCheckout(input);
  h.onchainUnavailable=true;
  const unavailable=status(c);
  assert.equal(unavailable.status,'pending');
  assert.equal(unavailable.onchain.status_available,false);
  assert.equal(unavailable.payment_request,c.payment_request);
  h.onchainUnavailable=false;
  for(const bad of [
    {receivedSat:100n,confirmedSat:99n,unconfirmedSat:0n},
    {receivedSat:100n,confirmedSat:100n,unconfirmedSat:0n,checkedAt:0n},
    {receivedSat:100n,confirmedSat:100n,unconfirmedSat:0n,checkedAt:999n},
    {receivedSat:9007199254740992n,confirmedSat:9007199254740992n,unconfirmedSat:0n}
  ]) {
    h.onchainTotals=bad;
    assert.equal(status(c).status,'pending');
    assert.equal(status(c).onchain.status_available,false);
  }
  h.onchainTotals={receivedSat:100n,confirmedSat:100n,unconfirmedSat:0n};
  assert.equal(status(c).status,'paid');
  assert.equal(h.reservations.length,1);
});

test('mismatched core network is never shown to the cashier',()=>{
  const {h,input}=setup();
  const reserve=h.host.reserveAddress;
  h.host.reserveAddress=(...args)=>({...reserve(...args),network:'Mainnet'});
  assert.throws(()=>h.pos.createCheckout(input));
  assert.equal(h.pos.createCheckout(input).onchain,null);
  assert.equal(h.reservations.length,1);
});

test('on-chain receipt tokens and wallet IDs stay private on every public path',()=>{
  const {h,t,input,status}=setup({remote_enabled:true});
  const c=h.pos.createCheckout(input);
  const publicData=[c,status(c),h.pos.getTerminal({link:t.cashier_link}),h.pos.getTerminal({link:t.display_link}),h.pos.publicHistory({link:t.cashier_link})];
  for(const value of publicData) {
    const serialized=JSON.stringify(value);
    assert.ok(!serialized.includes('alice_onchain'));
    assert.ok(!serialized.includes('private-status-token'));
    assert.ok(!serialized.includes('status_token'));
    assert.ok(!serialized.includes('onchain_wallet_id'));
  }
  assert.ok(JSON.parse(h.host.db.get('checkouts',c.id).data_json).onchain.status_token);
});

test('foreign owners, other terminals, displays and revoked links cannot reserve or inspect a checkout',()=>{
  const {h,t,input}=setup({remote_enabled:true});
  const c=h.pos.createCheckout(input);
  assert.throws(()=>h.pos.createCheckout({...input,link:t.display_link}));
  const other=h.create({onchain_enabled:true,onchain_wallet_id:'alice_onchain'});
  assert.throws(()=>h.pos.checkoutStatus({link:other.cashier_link,checkoutId:c.id}));
  assert.throws(()=>h.pos.getTerminal({link:other.cashier_link,checkoutId:c.id}));
  h.owner='bob';
  assert.throws(()=>h.pos.createCheckout(input));
  assert.throws(()=>h.pos.checkoutStatus({link:t.cashier_link,checkoutId:c.id}));
  assert.throws(()=>h.pos.getTerminal({link:t.cashier_link,checkoutId:c.id}));
  assert.throws(()=>h.pos.reconcile({id:t.id,checkout_id:c.id}));
  h.owner='alice';h.pos.rotateLinks({id:t.id});
  assert.throws(()=>h.pos.checkoutStatus({link:t.cashier_link,checkoutId:c.id}));
  assert.equal(h.reservations.length,1);
});

test('saved on-chain receipts and display remain readable without a status host call',()=>{
  const {h,t,input}=setup({remote_enabled:true});
  const c=h.pos.createCheckout(input);
  h.host.onchainStatus=()=>{throw Error('Core traps before a scan exists');};
  assert.equal(h.pos.getTerminal({link:t.cashier_link,checkoutId:c.id}).latest.payment_request,c.payment_request);
  assert.equal(h.pos.getTerminal({link:t.display_link}).latest.payment_request,c.payment_request);
  h.clock+=3;
  const newer=h.pos.createCheckout({...input,action_id:'newer_checkout'});
  assert.equal(h.pos.getTerminal({link:t.display_link,checkoutId:c.id}).latest.id,newer.id);
});

test('owner reconciliation uses on-chain status, and Lightning events cannot settle it',()=>{
  const {h,t,input,status}=setup();
  const c=h.pos.createCheckout(input);
  h.host.invoiceStatus=()=>{throw Error('Must not read a Lightning invoice');};
  h.host.refreshPayment=()=>{throw Error('Must not refresh a Lightning payment');};
  const event={extension:'pos',walletId:'alice_onchain',paymentHash:'fake',pending:false,status:'success',payment:{extension_context:{extension_id:'pos',wallet_id:'alice_onchain',source_id:c.id}}};
  assert.deepEqual(h.pos.recordPayment(event),{ignored:true});
  assert.equal(status(c).status,'pending');
  h.onchainTotals={receivedSat:100n,confirmedSat:100n,unconfirmedSat:0n};
  assert.equal(h.pos.reconcile({id:t.id,checkout_id:c.id}).status,'paid');
  assert.equal(h.payments.length,0);
});

test('reservation errors do not leak host details',()=>{
  const {h,input}=setup();h.loseReservation=true;
  const result=JSON.parse(invoke(h.pos,'createCheckout',JSON.stringify(input)));
  assert.equal(result.ok,false);
  assert.ok(!result.error.includes('secret'));
});
