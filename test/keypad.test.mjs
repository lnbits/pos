import test from 'node:test';
import assert from 'node:assert/strict';
import {keypadAmount,keypadShortcut} from '../ui/keypad.js';
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

test('keyboard keys use the same keypad actions',()=>{
  for(const key of '0123456789')assert.equal(keypadShortcut({key}),key);
  for(const [key,action] of [['Backspace','⌫'],['c','C'],['C','C'],['Escape','C'],['+','+'],['Enter','Enter']])assert.equal(keypadShortcut({key}),action);
  for(const key of ['Tab',' ','Delete','ArrowLeft','F11','a'])assert.equal(keypadShortcut({key}),null);
});

test('shortcuts ignore held keys, composition, browser shortcuts and editable fields',()=>{
  for(const flag of ['defaultPrevented','repeat','isComposing','ctrlKey','metaKey','altKey'])assert.equal(keypadShortcut({key:'Enter',[flag]:true}),null);
  for(const key of ['1','Enter','Backspace','Escape','+']){
    assert.equal(keypadShortcut({key,target:{isContentEditable:true}}),null);
    assert.equal(keypadShortcut({key,target:{matches:selector=>selector.includes('input')}}),null);
    assert.equal(keypadShortcut({key,composedPath:()=>[{}, {matches:selector=>selector.includes('textarea')}]}),null);
  }
});

test('Enter on a focused button cannot also submit a checkout',()=>{
  const target={matches:selector=>selector.includes('button')};
  assert.equal(keypadShortcut({key:'Enter',target}),null);
  assert.equal(keypadShortcut({key:'1',target}),'1');
});
