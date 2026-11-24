import {digits} from '../src/domain.js';

// Reset only the active cashier sale, once, after its saved attempt is cleared.
export function createCheckoutCompletion() {
  let completedId='',clearing=false;
  return async (checkout,{role,checkoutId,history},clear)=>{
    if(role!=='cashier' || history || !checkoutId || checkout?.id!==checkoutId || checkout.status!=='paid' || completedId===checkoutId || clearing)return false;
    clearing=true;
    try {
      if(!await clear())return false;
      completedId=checkoutId;
      return true;
    } finally {clearing=false;}
  };
}

export function receiptRate(checkout) {
  const {currency,exchange_rate:rate}=checkout.sale;
  if(currency==='sat' || !Number.isFinite(rate) || rate<=0 || (checkout.method==='fiat' && checkout.business?.only_show_sats_on_bitcoin!==false))return '';
  return `Rate: ${rate.toLocaleString(undefined,{maximumFractionDigits:8})} sats/${currency}`;
}

export function currentFiatValue(checkout,rate) {
  if(checkout.status!=='paid' || !['lightning','onchain'].includes(checkout.method) || checkout.sale.currency==='sat' || !Number.isFinite(rate) || rate<=0 || !Number.isSafeInteger(checkout.amount_sat) || checkout.amount_sat<=0)return null;
  const value=Math.round(checkout.amount_sat/rate*10**digits(checkout.sale.currency));
  return Number.isSafeInteger(value) && value>=0 ? value : null;
}
