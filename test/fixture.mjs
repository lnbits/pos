import {createPos} from '../src/pos.js';

export function fixture() {
  const h={owner:'alice',clock:100,serial:0,rows:new Map(),invoices:new Map(),payments:[],loseInvoice:false,payPending:false,payThrows:false,onchainReady:true,reservations:[],onchainTotals:{receivedSat:0n,confirmedSat:0n,unconfirmedSat:0n},onchainUnavailable:false,loseReservation:false};
  const key=(table,id)=>`${table}:${id}`;
  const copy=value=>structuredClone(value);
  const host={
    db:{
      get(table,id) { const r=h.rows.get(key(table,id)); return r?.owner===h.owner ? copy(r.data) : null; },
      set(table,data) {
        const k=key(table,data.id),old=h.rows.get(k);
        if (old && old.owner!==h.owner) throw Error('wrong owner');
        h.rows.set(k,{owner:h.owner,data:copy(data)});
      },
      delete(table,id) {
        if(host.db.get(table,id))h.rows.delete(key(table,id));
      },
      list(table,filters,limit,offset) {
        const rows=[...h.rows].filter(([k,r])=>k.startsWith(`${table}:`) && r.owner===h.owner && Object.entries(filters).every(([f,v])=>r.data[f]===v)).map(([,r])=>copy(r.data)).sort((a,b)=>(b.created_at||0)-(a.created_at||0));
        return {rows:rows.slice(offset,offset+limit),total:rows.length};
      }
    },
    id:prefix=>`${prefix}${String(++h.serial).padStart(32,'0')}`,
    now:()=>h.clock,
    wallets:()=>[{id:`${h.owner}_lightning`,name:'Lightning',currency:null,wallet_type:'lightning',receiving_ready:true},{id:`${h.owner}_tips`,name:'Tips',currency:null,wallet_type:'lightning',receiving_ready:true},{id:`${h.owner}_fiat`,name:'USD',currency:'USD',wallet_type:'fiat',receiving_ready:true},{id:`${h.owner}_onchain`,name:'Bitcoin',currency:null,wallet_type:'onchain',onchain_network:'Regtest',receiving_ready:h.onchainReady}],
    currencies:()=>['USD','EUR','JPY'],providers:()=>['stripe'],rate:()=>({rate:1000}),
    invoice:(id,amount,currency,memo)=>mint(id,amount*1000,'lnbc'),
    fiatInvoice:(id,amount,currency,memo)=>mint(id,Math.round(amount*1000*1000),'https://checkout.example/'),
    invoiceStatus:(hash,id)=>{
      const p=h.invoices.get(hash);
      if (!p || p.owner!==h.owner || p.source!==id) throw Error('unrelated invoice');
      return {paid:p.paid,pending:!p.paid && !p.failed,failed:p.failed,amountMsat:p.amount};
    },
    refreshPayment:()=>{},
    reserveAddress:(sourceId,checkoutId)=>{
      const saved=host.db.get('checkouts',checkoutId);
      if(!saved || saved.terminal_id!==sourceId || saved.wallet!==`${h.owner}_onchain` || !h.onchainReady)throw Error('unavailable wallet');
      const receipt={address:`bcrt1q${String(++h.serial).padStart(40,'0')}`,network:'Regtest',statusToken:`${checkoutId}.private-status-token`};
      h.reservations.push({owner:h.owner,walletId:saved.wallet,sourceId,checkoutId,...receipt});
      if(h.loseReservation)throw Error('secret-core-error');
      return receipt;
    },
    onchainStatus:(walletId,sourceId,checkoutId,address,statusToken)=>{
      if(h.onchainUnavailable)throw Error('secret-scan-error');
      if(!h.reservations.some(r=>r.owner===h.owner&&r.walletId===walletId&&r.sourceId===sourceId&&r.checkoutId===checkoutId&&r.address===address&&r.statusToken===statusToken))throw Error('unrelated checkout');
      return {checkedAt:BigInt(h.clock),...h.onchainTotals};
    },
    payInvoice:(wallet,invoice,amount)=>pay(wallet,invoice,amount),
    payLnurl:(wallet,address,amount)=>pay(wallet,address,amount),
    publish:()=>{}
  };
  function mint(source,amount,prefix) {
    const hash=String(++h.serial).padStart(64,'a');
    h.invoices.set(hash,{owner:h.owner,source,amount,paid:false,failed:false});
    if (h.loseInvoice) throw Error('secret-provider-detail');
    return {paymentHash:hash,paymentRequest:`${prefix}${hash}`,amountMsat:amount};
  }
  function pay(wallet,target,amount) {
    h.payments.push({wallet,target,amount});
    if (h.payThrows) throw Error('secret-wallet-key');
    return {ok:true,success:!h.payPending,pending:h.payPending,paymentHash:'b'.repeat(64)};
  }
  h.pos=createPos(host);
  h.host=host;
  h.input=(overrides={})=>({name:'Cafe',currency:'sat',wallet:`${h.owner}_lightning`,tax_inclusive:true,tax_default:0,products:[{id:'product_01',title:'Coffee',price:'100',tax:null}],...overrides});
  h.create=(overrides={})=>h.pos.saveTerminal(h.input(overrides));
  h.sale=(t,overrides={})=>({link:t.cashier_link,action_id:'action_12345',method:'lightning',items:[{product_id:'product_01',quantity:1}],...overrides});
  h.markPaid=hash=>{ h.invoices.get(hash).paid=true; };
  h.event=hash=>{
    const p=h.invoices.get(hash),c=host.db.get('checkouts',p.source);
    return {extension:'pos',paymentHash:hash,walletId:c.wallet,pending:false,status:'success',payment:{extension_context:{extension_id:'pos',source_id:p.source,wallet_id:c.wallet}}};
  };
  return h;
}
