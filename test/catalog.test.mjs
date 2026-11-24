import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.mjs';
import {productCategories} from '../src/domain.js';

test('multiple product categories survive saving and public catalog reads',()=>{
  const h=fixture();
  const t=h.create({products:[{id:'product_01',title:'Coffee',price:'100',categories:[' Drinks ','Hot','Drinks']}]});
  assert.deepEqual(t.products[0].categories,['Drinks','Hot']);
  assert.deepEqual(h.pos.terminalSettings({id:t.id}).products[0].categories,['Drinks','Hot']);
  assert.deepEqual(h.pos.getTerminal({link:t.cashier_link}).products[0].categories,['Drinks','Hot']);
  const saved=h.pos.saveTerminal({...h.pos.terminalSettings({id:t.id}),name:'New name'});
  assert.deepEqual(saved.products[0].categories,['Drinks','Hot']);
  assert.equal(h.pos.createCheckout(h.sale(t)).amount_sat,100);
  h.owner='bob';
  assert.throws(()=>h.pos.terminalSettings({id:t.id}));
  assert.throws(()=>h.pos.saveTerminal({...saved,products:[]}));
});

test('legacy single categories stay readable and convert when saved',()=>{
  const h=fixture(),t=h.create();
  const row=h.host.db.get('terminals',t.id),data=JSON.parse(row.data_json);
  delete data.products[0].categories;data.products[0].category='Drinks';
  h.host.db.set('terminals',{...row,data_json:JSON.stringify(data)});
  const old=h.pos.terminalSettings({id:t.id});
  assert.deepEqual(productCategories(old.products[0]),['Drinks']);
  assert.deepEqual(productCategories(h.pos.getTerminal({link:t.cashier_link}).products[0]),['Drinks']);
  assert.deepEqual(h.pos.saveTerminal(old).products[0].categories,['Drinks']);
  // Clearing the new array must not restore a stale legacy category.
  assert.deepEqual(productCategories({category:'Drinks',categories:[]}),[]);
});

test('category lists are bounded and malformed names are rejected',()=>{
  const h=fixture(),product={id:'product_01',title:'Coffee',price:'100'};
  for(const categories of ['Drinks',{},[1],[''],['  '],['x'.repeat(41)],Array(11).fill('Drinks')]){
    assert.throws(()=>h.create({products:[{...product,categories}]}));
  }
  assert.throws(()=>h.create({products:[{...product,category:{}}]}));
  assert.deepEqual(productCategories({}),[]);
  assert.equal(h.create({products:[{...product,categories:Array.from({length:10},(_,i)=>`Category ${i}`)}]}).products[0].categories.length,10);
});

test('automatic receipt prompting is opt-in and only the owner can change it',()=>{
  const h=fixture(),t=h.create();
  assert.equal(h.pos.getTerminal({link:t.cashier_link}).enable_receipt_print,false);
  const saved=h.pos.saveTerminal({...h.pos.terminalSettings({id:t.id}),enable_receipt_print:true});
  assert.equal(saved.enable_receipt_print,true);
  assert.equal(h.pos.getTerminal({link:t.cashier_link}).enable_receipt_print,true);
  h.pos.createCheckout(h.sale(t,{enable_receipt_print:false}));
  assert.equal(h.pos.terminalSettings({id:t.id}).enable_receipt_print,true);
  h.owner='bob';assert.throws(()=>h.pos.saveTerminal({...saved,enable_receipt_print:false}));
});
