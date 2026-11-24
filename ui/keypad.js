import {decimal,minor} from '../src/domain.js';

// Like TPoS, digits enter the currency's smallest unit (123 → 1.23 USD).
export function keypadAmount(value,currency) {
  if(!/^\d{0,12}$/.test(value))throw Error('Invalid keypad amount.');
  const amount=decimal(Number(value),currency);
  minor(amount,currency);
  return amount;
}

export function keypadShortcut(event) {
  if(event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey)return null;
  const targets=event.composedPath?.() || [event.target];
  if(targets.some(target=>target?.isContentEditable || target?.matches?.('input,textarea,select,[role="textbox"],[role="combobox"]')))return null;
  // Let focused controls keep their normal Enter action.
  if(event.key==='Enter' && targets.some(target=>target?.matches?.('button,a,[role="button"]')))return null;
  if(/^[0-9]$/.test(event.key) || event.key==='+' || event.key==='Enter')return event.key;
  if(event.key==='Backspace')return '⌫';
  if(['c','C','Escape'].includes(event.key))return 'C';
  return null;
}
