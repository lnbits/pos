import {decimal,minor} from '../src/domain.js';

// Like TPoS, digits enter the currency's smallest unit (123 → 1.23 USD).
export function keypadAmount(value,currency) {
  if(!/^\d{0,12}$/.test(value))throw Error('Invalid keypad amount.');
  const amount=decimal(Number(value),currency);
  minor(amount,currency);
  return amount;
}
