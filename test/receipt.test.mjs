import test from 'node:test';
import assert from 'node:assert/strict';
import {createCheckoutCompletion,receiptRate,currentFiatValue} from '../ui/receipt.js';

const context={role:'cashier',checkoutId:'sale_12345',history:false};
const receipt={id:context.checkoutId,status:'paid',method:'lightning',amount_sat:2500,sale:{currency:'USD',exchange_rate:1000},business:{only_show_sats_on_bitcoin:true}};

test('only a paid active cashier checkout clears the cart, once',async()=>{
  const complete=createCheckoutCompletion();let cleared=0;
  const clear=async()=>{cleared++;return true;};
  for(const status of ['creating','pending','failed'])assert.equal(await complete({...receipt,status},context,clear),false);
  for(const change of [{role:'display'},{role:undefined},{history:true},{checkoutId:''},{checkoutId:'sale_other'}])assert.equal(await complete(receipt,{...context,...change},clear),false);
  assert.equal(await complete(null,context,clear),false);
  assert.equal(cleared,0);
  assert.equal(await complete(receipt,context,clear),true);
  assert.equal(await complete({...receipt},{...context},clear),false);
  assert.equal(cleared,1);
  assert.equal(await complete({...receipt,id:'sale_67890'},{...context,checkoutId:'sale_67890'},clear),true);
  assert.equal(cleared,2);
});

test('failed session cleanup can be retried and overlapping polls cannot clear twice',async()=>{
  const complete=createCheckoutCompletion();
  assert.equal(await complete(receipt,context,async()=>false),false);
  await assert.rejects(complete(receipt,context,async()=>{throw Error('Storage unavailable');}));
  let finish;const pending=complete(receipt,context,()=>new Promise(resolve=>{finish=resolve;}));
  assert.equal(await complete(receipt,context,()=>assert.fail('Duplicate cleanup')),false);
  finish(true);assert.equal(await pending,true);
  assert.equal(await complete(receipt,context,()=>assert.fail('Repeated cleanup')),false);
});

test('receipts use the original rate and respect fiat Bitcoin-detail settings',()=>{
  assert.match(receiptRate(receipt),/sats\/USD$/);
  assert.equal(receiptRate({...receipt,method:'fiat'}),'');
  assert.match(receiptRate({...receipt,method:'fiat',business:{only_show_sats_on_bitcoin:false}}),/sats\/USD$/);
  for(const rate of [undefined,null,0,-1,Infinity,NaN])assert.equal(receiptRate({...receipt,sale:{currency:'USD',exchange_rate:rate}}),'');
  assert.equal(receiptRate({...receipt,sale:{currency:'sat',exchange_rate:1}}),'');
});

test('history values Bitcoin at the current rate without changing sale data',()=>{
  assert.equal(currentFiatValue(receipt,2000),125);
  assert.equal(currentFiatValue({...receipt,method:'onchain'},2000),125);
  assert.equal(receipt.sale.exchange_rate,1000);
  assert.equal(currentFiatValue({...receipt,sale:{currency:'JPY'}},2000),1);
  assert.equal(currentFiatValue({...receipt,sale:{currency:'KWD'}},2000),1250);
  for(const change of [{method:'fiat'},{status:'pending'},{amount_sat:undefined},{amount_sat:0},{sale:{currency:'sat'}}])assert.equal(currentFiatValue({...receipt,...change},2000),null);
  for(const rate of [undefined,0,-1,Infinity,NaN])assert.equal(currentFiatValue(receipt,rate),null);
});
