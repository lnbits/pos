import test from 'node:test';
import assert from 'node:assert/strict';
import {cartStorage,checkoutSession,appearanceStorage} from '../ui/storage.js';

function storage(){
  const data=new Map();let failKey='';
  return {data,fail(key){failKey=key;},async request(action,{key,value}){
    if(action.endsWith('.get'))return {value:data.get(key)||''};
    if(action.endsWith('.remove')){data.delete(key);return {};}
    if(key===failKey)throw Error('Storage full');
    if(action.startsWith('storage.local'))assert.ok(Buffer.byteLength(value)<=1024);
    if(action.startsWith('storage.session'))assert.ok(value.length<=4096);
    data.set(key,value);return {};
  }};
}

test('held carts round-trip Unicode within core storage limits',async()=>{
  const bridge=storage(),local=cartStorage(bridge),cart={items:[{title:'茶'.repeat(2000),quantity:1}]};
  const [row]=await local.hold(cart,'Counter');
  assert.deepEqual(await local.load(row.id),cart);
  await local.remove(row.id);assert.deepEqual(await local.list(),[]);
  assert.equal(bridge.data.size,1);
});

test('failed held-cart index commit removes orphaned chunks',async()=>{
  const bridge=storage(),local=cartStorage(bridge);bridge.fail('held-index');
  await assert.rejects(local.hold({items:[{title:'Coffee'}]},'Counter'));
  assert.equal(bridge.data.size,0);
});

test('checkout reload keeps its original action and terminal',async()=>{
  const bridge=storage(),attempt={link:'cash_link1',action_id:'unique_checkout',items:[{note:'x'.repeat(5000)}]};
  await checkoutSession(bridge,attempt.link).save(attempt);
  assert.deepEqual(await checkoutSession(bridge,attempt.link).load(),attempt);
  assert.equal(await checkoutSession(bridge,'cash_link2').load(),null);
  await checkoutSession(bridge,attempt.link).clear();
  assert.equal(await checkoutSession(bridge,attempt.link).load(),null);
});

test('an incomplete checkout save is never resumed',async()=>{
  const bridge=storage(),session=checkoutSession(bridge,'cash_link1');bridge.fail('checkout.cash_link1');
  await assert.rejects(session.save({link:'cash_link1',items:[]}));
  assert.equal(await session.load(),null);
});

test('held cart notes survive reload and oversized indexes never lose saved carts',async()=>{
  const bridge=storage(),local=cartStorage(bridge);
  const [row]=await local.hold({items:[{title:'Coffee'}]},'  Table 3 — Ana  ');
  assert.equal((await cartStorage(bridge).list())[0].name,'Table 3 — Ana');
  let failed=false;
  for(let i=0;i<6;i++){
    try{await local.hold({items:[{title:'Tea'}]},'茶'.repeat(36));}
    catch{failed=true;break;}
  }
  assert.ok(failed);
  assert.deepEqual(await local.load(row.id),{items:[{title:'Coffee'}]});
  assert.ok(Buffer.byteLength(bridge.data.get('held-index'))<=1024);
});

test('appearance survives reload and invalid or unavailable storage uses defaults',async()=>{
  const bridge=storage();await appearanceStorage(bridge).save({mono:true,tileSize:240});
  assert.deepEqual(await appearanceStorage(bridge).load(),{mono:true,tileSize:240});
  for(const value of ['bad JSON','null','{"mono":"true","tileSize":999}']){
    bridge.data.set('appearance',value);
    assert.deepEqual(await appearanceStorage(bridge).load(),{mono:false,tileSize:160});
  }
  assert.deepEqual(await appearanceStorage({request:async()=>{throw Error('Denied');}}).load(),{mono:false,tileSize:160});
});

test('appearance writes stay ordered and recover after a failed save',async()=>{
  const bridge=storage(),preferences=appearanceStorage(bridge);
  bridge.fail('appearance');await assert.rejects(preferences.save({mono:true,tileSize:80}));
  bridge.fail('');
  await Promise.all([preferences.save({mono:true,tileSize:120}),preferences.save({mono:false,tileSize:200})]);
  assert.deepEqual(await preferences.load(),{mono:false,tileSize:200});
});
