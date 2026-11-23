import test from 'node:test';
import assert from 'node:assert/strict';
import {keypadAmount} from '../ui/keypad.js';
import {calculateSale} from '../src/domain.js';

test('TPoS digit entry respects currency precision',()=>{
  assert.equal(keypadAmount('123','sat'),'123');
  assert.equal(keypadAmount('123','USD'),'1.23');
  assert.equal(keypadAmount('123','JPY'),'123');
  assert.equal(keypadAmount('123','KWD'),'0.123');
  assert.equal(keypadAmount('123','CLF'),'0.0123');
  assert.equal(keypadAmount('','USD'),'0.00');
  assert.equal(keypadAmount('0001','USD'),'0.01');
});

test('keypad amounts remain exact when combined into a sale',()=>{
  const terminal={currency:'USD',products:[],tax_default:0,tax_inclusive:true,tips_enabled:false};
  const sale=calculateSale(terminal,{items:['10','20'].map(raw=>({title:'Custom amount',price:keypadAmount(raw,'USD'),quantity:1}))});
  assert.equal(sale.total_minor,30);
});

test('invalid or excessive digit entry is rejected before rendering or payment',()=>{
  for(const raw of ['1.23','-1','1e3','abc','1234567890123'])assert.throws(()=>keypadAmount(raw,'USD'));
  assert.throws(()=>keypadAmount('99999999999','sat'));
  assert.equal(keypadAmount('9999999999','sat'),'9999999999');
});
