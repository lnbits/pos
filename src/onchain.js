import {fail,integer,object,text} from './domain.js';

export function onchainFingerprint(input) {
  if(!Array.isArray(input.items)||input.items.length<1||input.items.length>100)fail('Add between 1 and 100 cart lines.');
  const items=input.items.map(line=>{
    object(line);
    return {product_id:line.product_id,title:line.product_id?undefined:line.title,price:line.price,quantity:line.quantity,note:line.note||''};
  });
  return JSON.stringify({items,tip:input.tip||'0',note:input.note||''});
}

// The checkout is saved before allocation. Core allocates a NEW address on every
// call, so an uncertain response/save must never trigger another reservation.
export function reserveOnchain(host,checkout,settings,amountSat) {
  const receipt=host.reserveAddress(checkout.terminal_id,checkout.id);
  const address=text(receipt.address,'on-chain address',100,true);
  const network=text(receipt.network,'on-chain network',32,true);
  const token=text(receipt.statusToken,'checkout token',128,true);
  if(!/^[A-Za-z0-9]{14,100}$/.test(address) || network!==settings.onchain_network)fail('On-chain reservation is unavailable.');
  return {
    payment_request:`bitcoin:${address}?amount=${btcAmount(amountSat)}`,
    receipt:{address,network,status_token:token,zero_conf:settings.onchain_zero_conf===true,received_sat:0,confirmed_sat:0,unconfirmed_sat:0,checked_at:0}
  };
}

export function readOnchain(host,checkout,data) {
  const saved=data.onchain;
  if(!saved?.status_token)fail('On-chain reservation needs owner review.');
  const result=host.onchainStatus(checkout.wallet,checkout.terminal_id,checkout.id,saved.address,saved.status_token);
  const received=integer(Number(result.receivedSat),'received amount',0,Number.MAX_SAFE_INTEGER);
  const confirmed=integer(Number(result.confirmedSat),'confirmed amount',0,Number.MAX_SAFE_INTEGER);
  const unconfirmed=integer(Number(result.unconfirmedSat),'unconfirmed amount',0,Number.MAX_SAFE_INTEGER);
  const checked=integer(Number(result.checkedAt),'scan time',1,host.now());
  if(received!==confirmed+unconfirmed)fail('On-chain payment totals are unavailable.');
  const eligible=saved.zero_conf ? received : confirmed;
  return {
    // A completed sale remains an accepted receipt, as with Lightning.
    status:checkout.status==='paid'||eligible>=data.amount_sat ? 'paid' : 'pending',
    receipt:{...saved,received_sat:received,confirmed_sat:confirmed,unconfirmed_sat:unconfirmed,checked_at:checked}
  };
}

export function onchainView(checkout,data) {
  if(checkout.method!=='onchain')return {};
  const receipt=data.onchain;
  return {onchain:receipt ? {
    address:receipt.address,network:receipt.network,zero_conf:receipt.zero_conf,
    received_sat:receipt.received_sat,confirmed_sat:receipt.confirmed_sat,
    unconfirmed_sat:receipt.unconfirmed_sat,checked_at:receipt.checked_at,
    status_available:!checkout.onchain_status_unavailable&&receipt.checked_at>0
  } : null};
}

function btcAmount(sats) {
  integer(sats,'Bitcoin amount',1,1e9);
  return `${Math.floor(sats/100000000)}.${String(sats%100000000).padStart(8,'0')}`;
}
