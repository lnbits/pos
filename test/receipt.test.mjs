import test from 'node:test';
import assert from 'node:assert/strict';
import {createReceiptPrompt} from '../ui/receipt.js';

const context={role:'cashier',enabled:true,checkoutId:'sale_12345',history:false};
const receipt={id:context.checkoutId,status:'paid'};

test('only a paid active checkout triggers the print prompt',()=>{
  const prompt=createReceiptPrompt();
  for(const status of ['creating','pending','failed'])assert.equal(prompt({...receipt,status},context),false);
  assert.equal(prompt(receipt,context),true);
  assert.equal(prompt(receipt,context),false);
  assert.equal(prompt({...receipt},{...context}),false);
  assert.equal(prompt({...receipt,id:'sale_67890'},{...context,checkoutId:'sale_67890'}),true);
});

test('display screens, history and unrelated checkouts never trigger printing',()=>{
  const prompt=createReceiptPrompt();
  for(const change of [{role:'display'},{role:undefined},{enabled:false},{enabled:undefined},{enabled:'true'},{history:true},{checkoutId:''},{checkoutId:'sale_other'}]){
    assert.equal(prompt(receipt,{...context,...change}),false);
  }
  assert.equal(prompt(null,context),false);
  assert.equal(prompt(receipt,context),true);
  assert.equal(prompt(receipt,{...context,history:true}),false);
  assert.equal(prompt(receipt,context),false);
});
