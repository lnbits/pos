import {InputError, object, identifier, integer, normalizeTerminal, calculateSale, publicTerminal, digits, percent, proportion, fail} from './domain.js';
import {reserveOnchain,readOnchain,onchainView,onchainFingerprint} from './onchain.js';

// The host scopes every private storage operation to its invocation owner.
// All state-changing exports additionally use core's per-owner sync lock.
export function createPos(host) {
  const {db} = host;
  const save = (table,row) => { db.set(table,row); return row; };
  const payload = row => JSON.parse(row.data_json);
  const terminal = id => {
    const row = db.get('terminals',identifier(id));
    if (!row) fail('Terminal is unavailable.');
    return row;
  };
  const access = (link,write=false) => {
    const row = db.get('links',identifier(link));
    if (!row || row.revoked || (write && row.role !== 'cashier')) fail('Terminal is unavailable.');
    const t = terminal(row.terminal_id);
    if (!t.active || (row.role === 'display' && !payload(t).remote_enabled)) fail('Terminal is unavailable.');
    return {row,t,settings:payload(t)};
  };
  const checkout = (id,terminalId) => {
    const row = db.get('checkouts',identifier(id));
    if (!row || (terminalId && row.terminal_id !== terminalId)) fail('Checkout is unavailable.');
    return row;
  };
  const notify = t => {
    // Channels carry invalidation hints only. Never trust client websocket messages.
    try { host.publish(t.display_link,{refresh:true}); } catch (_) { /* Polling recovers. */ }
  };
  const view = c => {
    const data = payload(c);
    return {id:c.id,status:c.status,method:c.method,payment_hash:c.payment_hash,payment_request:c.payment_request,amount_sat:data.amount_sat,created_at:c.created_at,sale:data.sale,business:data.business,terminal_name:data.terminal_name,...onchainView(c,data)};
  };
  const summary = c => {
    const {id,status,method,created_at,sale,amount_sat,terminal_name}=view(c);
    const {currency,total_minor,tax_minor,tip_minor,exchange_rate}=sale;
    return {id,status,method,created_at,amount_sat,terminal_name,sale:{currency,total_minor,tax_minor,tip_minor,exchange_rate}};
  };
  const settle = (c,sendShares=true) => {
    if (c.method==='onchain') {
      if (c.status==='creating') return c;
      const data=payload(c);
      let update;
      try { update=readOnchain(host,c,data); }
      catch (_) { return {...c,onchain_status_unavailable:true}; }
      const next={...c,status:update.status,data_json:JSON.stringify({...data,onchain:update.receipt})};
      if (next.status!==c.status || next.data_json!==c.data_json) save('checkouts',next);
      return next;
    }
    if (!c.payment_hash) return c;
    const result = host.invoiceStatus(c.payment_hash,c.id);
    if (Number(result.amountMsat) !== c.amount_msat) fail('Payment amount does not match this checkout.');
    if (result.paid && !result.pending && !result.failed) {
      if (c.status !== 'paid') { c.status='paid'; save('checkouts',c); }
      if (sendShares) payShares(c);
    } else if (result.failed && c.status !== 'paid') {
      c.status='failed'; save('checkouts',c);
    }
    return c;
  };
  const payShares = c => {
    if (c.method !== 'lightning') return;
    const data = payload(c);
    const states = JSON.parse(c.payouts_json);
    for (const kind of ['tip','revenue']) {
      const payout = data[kind];
      if (!payout?.amount || states[kind]) continue;
      // Persist BEFORE a payment call. A crash/timeout must never cause a blind resend.
      states[kind]={state:'review',amount_sat:payout.amount};
      c.payouts_json=JSON.stringify(states); save('checkouts',c);
      try {
        let result;
        if (kind === 'tip') {
          const source=host.id('tip_');
          save('tip_sources',{id:source,wallet:payout.wallet});
          const invoice=host.invoice(source,payout.amount,'sat','PoS tip');
          result=host.payInvoice(c.wallet,invoice.paymentRequest,payout.amount,'PoS tip');
        } else {
          result=host.payLnurl(c.wallet,payout.address,payout.amount);
        }
        states[kind]={...states[kind],state:result.ok && result.success && !result.pending ? 'paid' : result.pending ? 'pending' : 'review',payment_hash:result.paymentHash || ''};
      } catch (_) {
        // Report only a safe state. Host errors may contain wallet or provider details.
      }
      c.payouts_json=JSON.stringify(states); save('checkouts',c);
    }
  };
  return {
    metadata() {
      return {wallets:host.wallets(),currencies:['sat',...host.currencies()],providers:host.providers()};
    },
    listTerminals() {
      return db.list('terminals',{},100,0).rows.map(t=>{
        const {name,currency,provider,tips_enabled,tip_wallet,revenue_address,revenue_percent,remote_enabled,wallet,products}=payload(t);
        return {name,currency,provider,tips_enabled,tip_wallet,revenue_address,revenue_percent,remote_enabled,wallet,product_count:products.length,id:t.id,active:t.active,cashier_link:t.cashier_link,display_link:t.display_link};
      });
    },
    terminalSettings(input) {
      const t=terminal(input.id);
      return {...payload(t),id:t.id};
    },
    saveTerminal(input) {
      const previous=input.id ? terminal(input.id) : null;
      const append=input.append_products!==undefined;
      if (append) {
        if (!previous || !Array.isArray(input.append_products)) fail('Select a terminal and valid products to import.');
        const saved=payload(previous);
        input={...saved,products:[...saved.products,...input.append_products]};
      }
      if (!previous && db.list('terminals',{},0,0).total >= 50) fail('Terminal limit reached.');
      const settings=normalizeTerminal(input,host.currencies(),host.wallets());
      if (settings.provider && !host.providers().includes(settings.provider)) fail('Fiat provider is unavailable.');
      const id=previous?.id || host.id('pos_');
      const row={id,active:append ? previous.active : true,cashier_link:previous?.cashier_link || host.id('cash_'),display_link:previous?.display_link || host.id('display_'),last_created:previous?.last_created || 0,latest_checkout:previous?.latest_checkout || '',data_json:JSON.stringify(settings)};
      if (!previous) {
        save('links',{id:row.cashier_link,terminal_id:id,role:'cashier',revoked:false});
        save('links',{id:row.display_link,terminal_id:id,role:'display',revoked:false});
      }
      save('terminals',row); notify(row);
      return {...settings,id,active:row.active,cashier_link:row.cashier_link,display_link:row.display_link};
    },
    disableTerminal(input) {
      const t=terminal(input.id); t.active=false; save('terminals',t); notify(t);
      return {disabled:true};
    },
    deleteTerminal(input) {
      const t=terminal(input.id);
      // Disable first: interruption during revocation must leave every link closed.
      t.active=false; save('terminals',t); notify(t);
      for (const id of [t.cashier_link,t.display_link]) {
        const link=db.get('links',id); if (link) save('links',{...link,revoked:true});
      }
      db.delete('terminals',t.id);
      return {deleted:true};
    },
    rotateLinks(input) {
      const t=terminal(input.id);
      // Revoke first. Partial failure fails closed; the owner can retry.
      for (const id of [t.cashier_link,t.display_link]) {
        const link=db.get('links',id); if (link) save('links',{...link,revoked:true});
      }
      t.cashier_link=host.id('cash_'); t.display_link=host.id('display_');
      save('links',{id:t.cashier_link,terminal_id:t.id,role:'cashier',revoked:false});
      save('links',{id:t.display_link,terminal_id:t.id,role:'display',revoked:false});
      save('terminals',t);
      return {cashier_link:t.cashier_link,display_link:t.display_link};
    },
    getTerminal(input) {
      const {row,t,settings}=access(input.link);
      let latest=null;
      const checkoutId=row.role==='display' ? t.latest_checkout : input.checkoutId;
      if (checkoutId) {
        const c=checkout(checkoutId,t.id);
        // Host errors trap the WASM call. Keep saved on-chain receipts readable
        // while core is syncing; the browser polls checkout-status separately.
        latest=view(c.method==='onchain' ? {...c,onchain_status_unavailable:c.status!=='paid'} : settle(c));
      }
      return {...publicTerminal(settings),role:row.role,channel:row.role==='display' ? t.display_link : '',latest};
    },
    createCheckout(input) {
      const {t,settings}=access(input.link,true);
      const action=identifier(input.action_id);
      const method=input.method;
      const prior=db.list('checkouts',{terminal_id:t.id,action_id:action},1,0).rows[0];
      const onchainAttempt=method==='onchain' ? onchainFingerprint(input) : '';
      if (prior?.method==='onchain') {
        if (method!=='onchain' || payload(prior).onchain_attempt!==onchainAttempt) fail('Checkout retry does not match the original cart.');
        return view(prior);
      }
      if (!['lightning','fiat','onchain'].includes(method) || (method==='fiat' && !settings.provider) || (method==='onchain' && (!settings.onchain_enabled || !settings.onchain_wallet_id))) fail('Payment method is unavailable.');
      const sale=calculateSale(settings,input);
      const fingerprint=JSON.stringify({method,sale});
      if (prior) {
        if (payload(prior).fingerprint !== fingerprint) fail('Checkout retry does not match the original cart.');
        return view(prior);
      }
      const now=host.now();
      if (now-t.last_created < 2) fail('Please wait before creating another checkout.');
      const open=db.list('checkouts',{terminal_id:t.id,status:'pending'},0,0).total + db.list('checkouts',{terminal_id:t.id,status:'creating'},0,0).total;
      if (open >= 100) fail('Too many open checkouts. Check pending sales in the owner screen.');
      const rate=settings.currency==='sat' ? 1 : host.rate(settings.currency).rate;
      if (!Number.isFinite(rate) || rate <= 0) fail('Exchange rate is unavailable.');
      const sats=integer(Math.ceil(sale.total_minor / 10**digits(settings.currency) * rate),'Bitcoin amount',1,1e9);
      const tipSats=proportion(sats,sale.tip_minor,sale.total_minor);
      const data={sale:{...sale,exchange_rate:rate},fingerprint,terminal_name:settings.name,amount_sat:sats,
        ...(method==='onchain' ? {onchain_attempt:onchainAttempt} : {}),
        business:{name:settings.business_name,address:settings.business_address,vat_id:settings.business_vat_id,only_show_sats_on_bitcoin:settings.only_show_sats_on_bitcoin},
        tip:settings.tip_wallet && settings.tip_wallet!==settings.wallet ? {wallet:settings.tip_wallet,amount:tipSats} : null,
        revenue:settings.revenue_address ? {address:settings.revenue_address,amount:proportion(sats-tipSats,percent(settings.revenue_percent),10000)} : null};
      const c={id:host.id('sale_'),terminal_id:t.id,action_id:action,wallet:method==='onchain' ? settings.onchain_wallet_id : method==='fiat' ? settings.fiat_wallet : settings.wallet,provider:method==='fiat' ? settings.provider : '',method,status:'creating',created_at:now,payment_hash:'',payment_request:'',amount_msat:method==='lightning' ? sats*1000 : 0,payouts_json:'{}',data_json:JSON.stringify(data)};
      save('checkouts',c);
      t.last_created=now; t.latest_checkout=c.id; save('terminals',t);
      try {
        if (method==='onchain') {
          const reservation=reserveOnchain(host,c,settings,sats);
          c.payment_request=reservation.payment_request;
          c.data_json=JSON.stringify({...data,onchain:reservation.receipt});
        } else {
          const invoice=method==='fiat' ? host.fiatInvoice(c.id,sale.total_minor/10**digits(settings.currency),settings.currency,settings.name) : host.invoice(c.id,sats,'sat',settings.name);
          c.payment_hash=invoice.paymentHash;
          c.payment_request=invoice.paymentRequest;
          if (method==='fiat') c.amount_msat=integer(Number(invoice.amountMsat),'invoice amount',1,Number.MAX_SAFE_INTEGER);
        }
        c.status='pending'; save('checkouts',c);
      } catch (_) {
        // The invoice/address might exist. Never allocate again after uncertainty.
        notify(t);
        fail('Checkout creation was not confirmed. Retry this same cart to view its state; do not pay twice.');
      }
      notify(t);
      return view(c);
    },
    checkoutStatus(input) {
      const {row,t}=access(input.link);
      if (row.role==='display' && input.checkoutId !== t.latest_checkout) fail('Checkout is unavailable.');
      const c=checkout(input.checkoutId,t.id);
      const result=settle(c); notify(t); return view(result);
    },
    publicHistory(input) {
      const {t}=access(input.link,true);
      return db.list('checkouts',{terminal_id:t.id},25,0).rows.map(summary);
    },
    historyRate(input) {
      access(input.link,true);
      return currentRate(host,input.currency);
    },
    salesRate(input) {
      return currentRate(host,input.currency);
    },
    sales(input) {
      const filters=input.id ? {terminal_id:terminal(input.id).id} : {};
      const offset=integer(Number(input.offset || 0),'page',0,1e7);
      const page=db.list('checkouts',filters,50,offset);
      return {total:page.total,rows:page.rows.map(c=>({...summary(c),payouts:JSON.parse(c.payouts_json)}))};
    },
    saleReceipt(input) {
      return view(checkout(input.checkoutId));
    },
    reconcile(input) {
      const c=checkout(input.checkout_id,input.id ? terminal(input.id).id : undefined);
      if (c.method!=='onchain' && c.payment_hash && c.status==='pending') host.refreshPayment(c.wallet,c.payment_hash);
      // Authenticated refresh must not bypass background-payment grants.
      // A paid event or cashier poll handles configured payouts under those grants.
      return {...view(settle(c,false)),payouts:JSON.parse(c.payouts_json)};
    },
    recordPayment(event) {
      object(event);
      const binding=event.payment?.extension_context;
      if (event.extension!=='pos' || !binding || binding.extension_id!=='pos' || event.pending || event.status!=='success') return {ignored:true};
      const c=db.get('checkouts',binding.source_id);
      if (!c || c.method==='onchain' || binding.wallet_id!==event.walletId || (c.payment_hash && c.payment_hash!==event.paymentHash)) return {ignored:true};
      // Recheck the host's immutable source binding, including early-settlement recovery.
      const status=host.invoiceStatus(event.paymentHash,c.id);
      if (!status.paid || status.pending || status.failed) return {ignored:true};
      if (c.amount_msat && Number(status.amountMsat)!==c.amount_msat) fail('Payment amount does not match this checkout.');
      c.payment_hash=event.paymentHash;
      c.amount_msat=integer(Number(status.amountMsat),'invoice amount',1,Number.MAX_SAFE_INTEGER);
      c.status='paid'; save('checkouts',c); payShares(c);
      const t=db.get('terminals',c.terminal_id); if (t) notify(t);
      return {recorded:true};
    }
  };
}

export function invoke(pos,method,json) {
  try { return JSON.stringify({ok:true,data:pos[method](object(JSON.parse(json)))}); }
  catch (error) { return JSON.stringify({ok:false,error:error instanceof InputError ? error.message : 'Request could not be completed. Please try again or contact the terminal owner.'}); }
}

function currentRate(host,currency) {
  if (currency!=='sat' && !host.currencies().includes(currency)) fail('Unsupported currency.');
  const rate=currency==='sat' ? 1 : host.rate(currency).rate;
  if (!Number.isFinite(rate) || rate<=0) fail('Exchange rate is unavailable.');
  return {rate};
}
