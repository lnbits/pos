<script setup>
import {ref,computed,onMounted,onBeforeUnmount} from 'vue';
import QRCode from 'qrcode';
import {createBridge} from './bridge.js';
import {cartStorage,checkoutSession} from './storage.js';
import {calculateSale,decimal,minor,digits} from '../src/domain.js';

const bridge=createBridge(),local=cartStorage(bridge);
const loading=ref(true),busy=ref(false),error=ref(''),notice=ref(''),dark=ref(false),isPublic=ref(false),link=ref('');
const terminals=ref([]),meta=ref({wallets:[],currencies:['sat'],providers:[]}),editor=ref(null),editorTab=ref('settings'),productFile=ref(null);
const terminal=ref(null),items=ref([]),note=ref(''),tip=ref('0'),search=ref(''),category=ref(''),view=ref('products'),keypad=ref(''),history=ref([]),showHistory=ref(false),held=ref([]),showHeld=ref(false);
const invoice=ref(null),invoiceQr=ref(''),share=ref(null),shareQr=ref(''),sales=ref(null),offset=ref(0),salesTerminal=ref(null),importText=ref('');
const rounding=ref(''),cashierAttempt=ref(null);
const confirmation=ref(null),receiptOnly=ref(false);
let previousCheckout=null;
let timer,unsubscribe,session,polling=false,qrSequence=0;
function ask(message){return new Promise(resolve=>{confirmation.value={message,resolve};});}
function answer(value){confirmation.value?.resolve(value);confirmation.value=null;}

const categories=computed(()=>[...new Set((terminal.value?.products||[]).filter(p=>!p.disabled&&p.category).map(p=>p.category))]);
const products=computed(()=>(terminal.value?.products||[]).filter(p=>!p.disabled&&(!category.value||p.category===category.value)&&(`${p.title} ${p.description}`).toLowerCase().includes(search.value.toLowerCase())));
const preview=computed(()=>{
  if(!terminal.value || !items.value.length)return null;
  try{return calculateSale(terminal.value,{items:items.value,tip:tip.value,note:note.value});}catch{return null;}
});
const currentCurrency=computed(()=>terminal.value?.currency||'sat');
function money(value,currency=currentCurrency.value){return `${decimal(value,currency)} ${currency==='sat'?'sats':currency}`;}
function timestamp(value){return new Date(value*1000).toLocaleString();}
function clone(value){return JSON.parse(JSON.stringify(value));}
function blank(){return {name:'',currency:'sat',wallet:'',tip_wallet:'',fiat_wallet:'',provider:'',tax_inclusive:true,tax_default:0,allow_price_adjustment:true,tips_enabled:false,tip_options:[10,15,20],revenue_address:'',revenue_percent:0,business_name:'',business_address:'',business_vat_id:'',only_show_sats_on_bitcoin:true,remote_enabled:false,products:[]};}
async function run(fn){if(busy.value)return;busy.value=true;error.value='';notice.value='';try{return await fn();}catch(e){error.value=e.message||'Something went wrong.';}finally{busy.value=false;}}
async function loadAdmin(){[terminals.value,meta.value]=await Promise.all([bridge.api('/terminals'),bridge.api('/metadata')]);}
async function edit(t){await run(async()=>{editor.value=t?await bridge.api(`/terminals/${encodeURIComponent(t.id)}`):blank();editorTab.value='settings';});}
async function save(){await run(async()=>{await bridge.api('/terminals','POST',editor.value);editor.value=null;await loadAdmin();notice.value='Terminal saved.';});}
async function disable(t){if(!await ask(`Disable ${t.name}? Its shared links will stop working.`))return;await run(async()=>{await bridge.api('/terminals/disable','POST',{id:t.id});await loadAdmin();});}
async function rotate(t){if(!await ask('Replace both shared links? The old links will stop working.'))return;await run(async()=>{await bridge.api('/terminals/rotate','POST',{id:t.id});await loadAdmin();share.value=null;notice.value='Links replaced.';});}
function terminalUrl(token){return `${new URL(location.href).origin}/ext/pos/terminal/${encodeURIComponent(token)}`;}
async function shareTerminal(t){await run(async()=>{shareQr.value=await QRCode.toDataURL(terminalUrl(t.cashier_link),{width:260,margin:2});share.value={terminal:t,url:terminalUrl(t.cashier_link),display:terminalUrl(t.display_link)};});}
async function open(url){await run(()=>bridge.request('navigation.open_new_tab',{url}));}
async function background(t){await run(()=>bridge.request('permissions.request_background_payment',{forcePrompt:true,grant:{wallet_id:t.wallet}}));}
function addProduct(){editor.value.products.push({id:crypto.randomUUID().replaceAll('-',''),title:'',description:'',category:'',price:'',tax:null,disabled:false,image:''});}
function importProducts(){
  try {
    const raw=JSON.parse(importText.value);if(!Array.isArray(raw)||raw.length>100)throw Error('Import a JSON array of up to 100 products.');
    editor.value.products=raw.map(p=>({id:crypto.randomUUID().replaceAll('-',''),title:p.title,description:p.description||'',price:String(p.price),tax:p.tax??null,category:p.category||(p.categories||[])[0]||'',disabled:p.disabled===true,image:p.image||''}));
    importText.value='';notice.value='Products imported. Review them and save the terminal.';
  } catch(e){error.value=e.message;}
}
async function readProductFile(e){const file=e.target.files?.[0];if(!file)return;if(file.size>64000){error.value='Use a JSON file smaller than 64 KB.';return;}importText.value=await file.text();}
async function exportTerminals(){await run(()=>bridge.request('ui.download_csv',{filename:'pos-terminals.csv',columns:['Name','Currency','Active','Tax included'],rows:terminals.value.map(t=>[t.name,t.currency,t.active,t.tax_inclusive])}));}
async function showSales(t){await run(async()=>{salesTerminal.value=t;offset.value=0;await loadSales();});}
async function loadSales(){sales.value=await bridge.api(`/sales?id=${encodeURIComponent(salesTerminal.value.id)}&offset=${offset.value}`);}
async function pageSales(delta){await run(async()=>{offset.value=Math.max(0,offset.value+delta);await loadSales();});}
async function reconcile(c){await run(async()=>{await bridge.api('/sales/reconcile','POST',{id:salesTerminal.value.id,checkout_id:c.id});await loadSales();});}
async function exportSales(){await run(()=>bridge.request('ui.download_csv',{filename:'pos-sales.csv',columns:['Date','Method','Status','Currency','Total','Tax','Tip'],rows:sales.value.rows.map(c=>[timestamp(c.created_at),c.method,c.status,c.sale.currency,decimal(c.sale.total_minor,c.sale.currency),decimal(c.sale.tax_minor,c.sale.currency),decimal(c.sale.tip_minor,c.sale.currency)])}));}

async function loadTerminal(){
  const t=await bridge.api(`/terminal/${link.value}`);terminal.value=t;
  if(t.role==='display')await setInvoice(t.latest);
}
function add(p){
  if(cashierAttempt.value)return;
  const line=items.value.find(l=>l.product_id===p.id && !l.note && l.price==null);
  if(line)line.quantity++;else items.value.push({product_id:p.id,quantity:1,note:''});
}
function title(line){return terminal.value.products.find(p=>p.id===line.product_id)?.title||line.title;}
function price(line){return line.price??terminal.value.products.find(p=>p.id===line.product_id)?.price??'0';}
function press(key){if(key==='⌫')keypad.value=keypad.value.slice(0,-1);else if(key==='C')keypad.value='';else if(keypad.value.length<14)keypad.value+=key;}
function addCustom(){try{minor(keypad.value,currentCurrency.value);if(Number(keypad.value)<=0)throw Error('Enter an amount.');items.value.push({title:'Custom amount',price:keypad.value,quantity:1,note:''});keypad.value='';}catch(e){error.value=e.message;}}
function setTip(pct){if(!preview.value)return;const base=preview.value.total_minor-preview.value.tip_minor;tip.value=decimal(Math.round(base*pct/100),currentCurrency.value);}
function roundTotal(){try{if(!preview.value)return;const base=preview.value.total_minor-preview.value.tip_minor,target=minor(rounding.value,currentCurrency.value);if(target<base)throw Error('Round-up total must cover the sale.');tip.value=decimal(target-base,currentCurrency.value);}catch(e){error.value=e.message;}}
async function clearCart(){try{await session?.clear();items.value=[];note.value='';tip.value='0';rounding.value='';cashierAttempt.value=null;invoice.value=null;invoiceQr.value='';}catch(e){error.value=e.message;}}
async function checkout(method){await run(async()=>{
  if(!cashierAttempt.value)cashierAttempt.value={link:link.value,action_id:crypto.randomUUID().replaceAll('-',''),method,items:clone(items.value),tip:tip.value,note:note.value};
  await session.save(clone(cashierAttempt.value));
  await setInvoice(await bridge.api(`/terminal/${link.value}/checkout`,'POST',cashierAttempt.value));
});}
async function setInvoice(c){
  const previous=invoice.value?.payment_request;invoice.value=c;
  if(c?.payment_request && c.payment_request!==previous){const seq=++qrSequence;const png=await QRCode.toDataURL(c.payment_request,{width:360,margin:2});if(seq===qrSequence)invoiceQr.value=png;}
  if(!c?.payment_request){qrSequence++;invoiceQr.value='';}
}
async function poll(){
  if(polling||busy.value||!isPublic.value||!terminal.value)return;polling=true;
  try {
    if(terminal.value.role==='display')await loadTerminal();
    else if(invoice.value?.id)await setInvoice(await bridge.api(`/terminal/${link.value}/status?checkoutId=${encodeURIComponent(invoice.value.id)}`));
  }catch(e){error.value=e.message;}finally{polling=false;}
}
async function closeCheckout(){
  if(receiptOnly.value){receiptOnly.value=false;await setInvoice(previousCheckout);previousCheckout=null;return;}
  if(invoice.value?.status==='paid'||invoice.value?.status==='failed'){await clearCart();return;}
  if(await ask('This checkout may still be paid. Start a separate sale? You can find this one in Recent sales.'))await clearCart();
}
async function recent(){await run(async()=>{history.value=await bridge.api(`/terminal/${link.value}/history`);showHistory.value=true;});}
async function viewReceipt(c){await run(async()=>{const receipt=await bridge.api(`/terminal/${link.value}/status?checkoutId=${encodeURIComponent(c.id)}`);previousCheckout=invoice.value;receiptOnly.value=true;showHistory.value=false;await setInvoice(receipt);});}
async function hold(){await run(async()=>{
  if(!items.value.length)throw Error('Add something to the cart first.');
  held.value=await local.hold({items:clone(items.value),tip:tip.value,note:note.value},new Date().toLocaleTimeString());await clearCart();notice.value='Cart held on this device.';
});}
async function heldCarts(){await run(async()=>{held.value=await local.list();showHeld.value=true;});}
async function resume(id){await run(async()=>{if(items.value.length&&!await ask('Replace the current cart?'))return;const c=await local.load(id);items.value=c.items;tip.value=c.tip||'0';note.value=c.note||'';await local.remove(id);showHeld.value=false;});}
async function removeHeld(id){await run(async()=>{await local.remove(id);held.value=await local.list();});}
async function print(c,order=false){await run(async()=>{
  const s=c.sale,b=c.business;
  const lines=[timestamp(c.created_at),c.terminal_name,`Payment: ${c.method} · ${c.status}`,b.name,b.address,b.vat_id?`VAT: ${b.vat_id}`:'',s.note].filter(Boolean);
  if(!order){lines.push(`Subtotal: ${money(s.subtotal_minor,s.currency)}`,`Tax${s.tax_inclusive?' (included)':''}: ${money(s.tax_minor,s.currency)}`,`Tip: ${money(s.tip_minor,s.currency)}`,`Total: ${money(s.total_minor,s.currency)}`);if(c.method==='lightning'||!b.only_show_sats_on_bitcoin)lines.push(`Bitcoin amount: ${c.amount_sat} sats`);}
  await bridge.request('ui.print_document',{title:order?'Order':'Receipt',lines,columns:order?['Item','Quantity','Note']:['Item','Quantity','Unit price','Note'],rows:s.items.map(l=>order?[l.title,l.quantity,l.note]:[l.title,l.quantity,money(l.price_minor,s.currency),l.note])});
});}
function theme(context){dark.value=Boolean(context?.dark??context?.darkMode??context?.isDark);}
onMounted(async()=>{
  try {
    const context=await bridge.request('context');isPublic.value=context.public;theme(context.theme);link.value=context.routeParams?.link||'';
    unsubscribe=bridge.onEvent(e=>{if(e.event==='ui.theme')theme(e.data);if(e.event==='websocket.message')poll();});
    if(isPublic.value){
      if(!/^[A-Za-z0-9_-]{8,128}$/.test(link.value))throw Error('Invalid terminal link.');
      await loadTerminal();
      session=checkoutSession(bridge,link.value);
      if(terminal.value.role==='cashier'){
        const saved=await session.load();
        if(saved){cashierAttempt.value=saved;items.value=saved.items;tip.value=saved.tip||'0';note.value=saved.note||'';notice.value='A checkout was in progress. Use Check / retry to safely resume it.';}
      }
      if(terminal.value.role==='display'&&terminal.value.channel)await bridge.request('websocket.subscribe',{subscriptionId:'display',itemId:terminal.value.channel});
      timer=setInterval(poll,5000);
    }else await loadAdmin();
  }catch(e){error.value=e.message;}finally{loading.value=false;}
});
onBeforeUnmount(()=>{clearInterval(timer);unsubscribe?.();bridge.close().catch(()=>{});});
</script>

<template>
<main class="pos" :class="{dark}">
  <header class="topbar">
    <div class="brand"><span class="brand-mark">₿</span><div><strong>{{ isPublic ? terminal?.name || 'PoS' : 'PoS' }}</strong><small>{{ isPublic ? terminal?.role === 'display' ? 'Customer display' : 'Ready for your next sale' : 'Your counter. Your payments.' }}</small></div></div>
    <div class="toolbar" v-if="!loading">
      <template v-if="!isPublic"><button @click="exportTerminals" :disabled="busy||!terminals.length">Export CSV</button><button class="primary" @click="edit()">＋ New terminal</button></template>
      <template v-else-if="terminal?.role==='cashier'"><button @click="recent" :disabled="busy">Recent sales</button><button @click="heldCarts" :disabled="busy||!!cashierAttempt">Held carts</button></template>
    </div>
  </header>
  <div v-if="error" role="alert" class="banner error">{{ error }}<button class="quiet" @click="error=''" aria-label="Dismiss error">×</button></div>
  <div v-if="notice" role="status" class="banner success">{{ notice }}</div>
  <div v-if="loading" class="empty"><span class="loader"></span><p>Connecting to LNbits…</p></div>

  <section v-else-if="!isPublic" class="dashboard">
    <div class="section-heading"><div><p class="eyebrow">WORKSPACE</p><h1>Your terminals</h1><p>Share a counter link with staff. Keep wallet settings here.</p></div><span class="count">{{terminals.filter(t=>t.active).length}} active</span></div>
    <div v-if="!terminals.length" class="empty card"><span class="large-icon">▦</span><h2>Open your first counter</h2><p>Choose a wallet, add your products, and start taking payments.</p><button class="primary" @click="edit()">Create a terminal</button></div>
    <div class="terminal-grid">
      <article class="card terminal-card" v-for="t in terminals" :key="t.id">
        <div class="row between"><span class="terminal-icon">▦</span><span class="badge" :class="t.active?'green':'muted'">{{t.active?'Active':'Disabled'}}</span></div>
        <h2>{{t.name}}</h2><p>{{t.currency==='sat'?'Priced in sats':t.currency}} · {{t.product_count}} products</p>
        <div class="tags"><span>Lightning</span><span v-if="t.provider">{{t.provider}}</span><span v-if="t.tips_enabled">Tips</span></div>
        <div class="card-actions"><button class="primary" @click="open(terminalUrl(t.cashier_link))" :disabled="!t.active||busy">Open counter ↗</button><button @click="shareTerminal(t)" :disabled="!t.active">Share</button></div>
        <div class="row wrap secondary-actions"><button class="quiet" @click="edit(t)">Edit</button><button class="quiet" @click="showSales(t)">Sales</button><button class="quiet" @click="background(t)" v-if="t.tip_wallet||t.revenue_address">Payment permission</button><button class="quiet" @click="rotate(t)">Replace links</button><button class="quiet danger" @click="disable(t)" v-if="t.active">Disable</button></div>
      </article>
    </div>
  </section>

  <section v-else-if="terminal?.role==='cashier'" class="counter">
    <div class="catalog">
      <div class="row between"><div class="segmented"><button :class="{selected:view==='products'}" @click="view='products'">Products</button><button :class="{selected:view==='keypad'}" @click="view='keypad'">Keypad</button></div><span class="currency-label">{{currentCurrency==='sat'?'SATS':currentCurrency}}</span></div>
      <template v-if="view==='products'">
        <input class="search" v-model="search" placeholder="Search products…" aria-label="Search products">
        <div class="categories"><button :class="{selected:!category}" @click="category=''">All</button><button v-for="c in categories" :key="c" :class="{selected:category===c}" @click="category=c">{{c}}</button></div>
        <div class="product-grid"><button v-for="p in products" :key="p.id" class="product" @click="add(p)" :disabled="!!cashierAttempt"><img v-if="p.image" :src="p.image" alt=""><span v-else class="product-letter">{{p.title.slice(0,1)}}</span><strong>{{p.title}}</strong><small v-if="p.description">{{p.description}}</small><span class="price">{{p.price}} {{currentCurrency==='sat'?'sats':currentCurrency}}</span></button></div>
        <div v-if="!products.length" class="empty"><h3>No products here yet</h3><p>Use the keypad to enter an amount.</p><button @click="view='keypad'">Open keypad</button></div>
      </template>
      <div v-else class="keypad"><div class="keypad-value">{{keypad||'0'}} <small>{{currentCurrency==='sat'?'sats':currentCurrency}}</small></div><div class="keypad-grid"><button v-for="key in ['1','2','3','4','5','6','7','8','9','C','0','.']" :key="key" @click="press(key)" :disabled="!!cashierAttempt">{{key}}</button></div><div class="row"><button @click="press('⌫')">⌫</button><button class="primary grow" @click="addCustom" :disabled="!!cashierAttempt">＋ Add to cart</button></div></div>
    </div>
    <aside class="cart card">
      <div class="row between"><h2>Current sale</h2><span class="count">{{items.reduce((s,l)=>s+l.quantity,0)}} items</span></div>
      <div class="cart-lines">
        <div v-if="!items.length" class="empty compact"><span class="large-icon">＋</span><p>Add products or enter an amount.</p></div>
        <div v-for="(line,i) in items" :key="i" class="cart-line">
          <div class="row between"><strong>{{title(line)}}</strong><button class="quiet danger" @click="items.splice(i,1)" :disabled="!!cashierAttempt" :aria-label="`Remove ${title(line)}`">×</button></div>
          <div class="row"><input type="number" min="1" max="999" v-model.number="line.quantity" class="quantity" aria-label="Quantity" :disabled="!!cashierAttempt"><span>×</span><input :value="price(line)" @input="line.price=$event.target.value" aria-label="Unit price" inputmode="decimal" :disabled="!!cashierAttempt||!!line.product_id&&!terminal.allow_price_adjustment"><span class="subtle">{{currentCurrency}}</span></div>
          <input v-model="line.note" placeholder="Item note" maxlength="160" aria-label="Item note" :disabled="!!cashierAttempt">
        </div>
      </div>
      <div class="cart-footer">
        <input v-model="note" maxlength="240" placeholder="Sale note (optional)" aria-label="Sale note" :disabled="!!cashierAttempt">
        <div v-if="terminal.tips_enabled&&items.length" class="tip-box"><div class="row between"><strong>Add a tip</strong><input v-model="tip" inputmode="decimal" aria-label="Tip amount" :disabled="!!cashierAttempt"></div><div class="row wrap"><button v-for="p in terminal.tip_options" :key="p" @click="setTip(p)" :disabled="!!cashierAttempt">{{p}}%</button><button @click="tip='0'" :disabled="!!cashierAttempt">No tip</button></div><div class="row"><input v-model="rounding" placeholder="Round total to…" inputmode="decimal" aria-label="Round-up total" :disabled="!!cashierAttempt"><button @click="roundTotal" :disabled="!!cashierAttempt">Round up</button></div></div>
        <div v-if="preview" class="totals"><div><span>Subtotal</span><span>{{money(preview.subtotal_minor)}}</span></div><div><span>Tax {{preview.tax_inclusive?'(included)':''}}</span><span>{{money(preview.tax_minor)}}</span></div><div v-if="preview.tip_minor"><span>Tip</span><span>{{money(preview.tip_minor)}}</span></div><div class="total"><strong>Total</strong><strong>{{money(preview.total_minor)}}</strong></div></div>
        <button class="primary pay-button" @click="checkout('lightning')" :disabled="busy||!preview">{{cashierAttempt?'Check / retry this checkout':'Charge with Lightning'}} →</button>
        <button v-if="terminal.fiat_enabled&&!cashierAttempt" class="pay-button" @click="checkout('fiat')" :disabled="busy||!preview">Hosted card checkout</button>
        <div class="row between"><button class="quiet" @click="hold" :disabled="busy||!items.length||!!cashierAttempt">Hold cart</button><button class="quiet" @click="clearCart" :disabled="!!cashierAttempt">Clear</button></div>
      </div>
    </aside>
  </section>

  <section v-else-if="terminal?.role==='display'&&!invoice" class="display-welcome"><span class="brand-mark">₿</span><h1>Welcome to {{terminal.name}}</h1><p>Your checkout will appear here.</p></section>

  <div v-if="editor" class="overlay"><section class="dialog wide" role="dialog" aria-modal="true" aria-label="Terminal settings">
    <header class="dialog-header"><div><p class="eyebrow">TERMINAL</p><h2>{{editor.id?'Edit counter':'Create a counter'}}</h2></div><button class="quiet" @click="editor=null" aria-label="Close">×</button></header>
    <div class="dialog-tabs"><button :class="{selected:editorTab==='settings'}" @click="editorTab='settings'">Settings</button><button :class="{selected:editorTab==='products'}" @click="editorTab='products'">Products ({{editor.products.length}})</button><button :class="{selected:editorTab==='receipt'}" @click="editorTab='receipt'">Receipt</button></div>
    <div class="dialog-body">
      <div v-if="editorTab==='settings'" class="form-grid">
        <label>Terminal name<input v-model="editor.name" maxlength="80" placeholder="Front counter"></label>
        <label>Price currency<select v-model="editor.currency"><option v-for="c in meta.currencies" :key="c" :value="c">{{c==='sat'?'Satoshis':c}}</option></select></label>
        <label class="span2">Lightning receiving wallet<select v-model="editor.wallet"><option value="">Select your Lightning wallet</option><option v-for="w in meta.wallets" :key="w.id" :value="w.id">{{w.name}}</option></select><small>Select a Lightning wallet.</small></label>
        <label>Default tax (%)<input v-model="editor.tax_default" type="number" min="0" max="100" step="0.01"></label>
        <label class="check"><input type="checkbox" v-model="editor.tax_inclusive">Prices include tax</label>
        <label class="check"><input type="checkbox" v-model="editor.allow_price_adjustment">Allow staff to adjust product prices</label>
        <label class="check"><input type="checkbox" v-model="editor.remote_enabled">Enable a separate customer display</label>
        <div class="form-section span2"><h3>Tips</h3><label class="check"><input type="checkbox" v-model="editor.tips_enabled">Offer tips at checkout</label></div>
        <template v-if="editor.tips_enabled"><label>Tip wallet<select v-model="editor.tip_wallet"><option value="">Keep tips in receiving wallet</option><option v-for="w in meta.wallets" :key="w.id" :value="w.id">{{w.name}}</option></select></label><label>Tip percentages<input :value="editor.tip_options.join(', ')" @change="editor.tip_options=$event.target.value.split(',').filter(s=>s.trim()).map(Number)" placeholder="10, 15, 20"></label><p class="help span2">Separate Lightning tips require background-payment permission. Fiat tips stay in the fiat receiving wallet.</p></template>
        <div class="form-section span2"><h3>Revenue sharing</h3><p class="help">Forward a percentage of each Lightning sale, excluding tips. Requires payment permission.</p></div>
        <label>Recipient Lightning address<input v-model="editor.revenue_address" placeholder="name@example.com" maxlength="254"></label><label>Share (%)<input v-model="editor.revenue_percent" type="number" min="0" max="100" step="0.01"></label>
        <div class="form-section span2"><h3>Hosted card payments</h3></div>
        <label>Provider<select v-model="editor.provider" :disabled="editor.currency==='sat'"><option value="">Disabled</option><option v-for="p in meta.providers" :key="p" :value="p">{{p}}</option></select></label><label v-if="editor.provider">Fiat receiving wallet<select v-model="editor.fiat_wallet"><option value="">Select a matching fiat wallet</option><option v-for="w in meta.wallets.filter(w=>w.currency?.toUpperCase()===editor.currency)" :key="w.id" :value="w.id">{{w.name}}</option></select></label>
      </div>
      <div v-else-if="editorTab==='products'">
        <div class="row between"><p class="help">Up to 100 products. Leave tax empty to use the default.</p><button @click="addProduct" :disabled="editor.products.length>=100">＋ Add product</button></div>
        <div v-for="(p,i) in editor.products" :key="p.id" class="product-editor"><div class="row between"><strong>Product {{i+1}}</strong><button class="quiet danger" @click="editor.products.splice(i,1)">Remove</button></div><div class="form-grid"><label>Name<input v-model="p.title" maxlength="80"></label><label>Price<input v-model="p.price" inputmode="decimal"></label><label>Category<input v-model="p.category" maxlength="40"></label><label>Tax (%)<input v-model="p.tax" type="number" min="0" max="100" step="0.01" placeholder="Default"></label><label class="span2">Description<input v-model="p.description" maxlength="240"></label><label class="check"><input type="checkbox" v-model="p.disabled">Hide from counter</label></div></div>
        <details class="import-box"><summary>Import products from JSON</summary><p class="help">Accepts TPoS product arrays. Import replaces this catalog. Remote image URLs must be removed; small data images are supported.</p><input ref="productFile" type="file" accept="application/json,.json" @change="readProductFile"><textarea v-model="importText" rows="5" placeholder='[{"title":"Coffee","price":2.50}]' aria-label="Products JSON"></textarea><button @click="importProducts">Import and review</button></details>
      </div>
      <div v-else class="form-grid"><label class="span2">Business name<input v-model="editor.business_name" maxlength="120"></label><label class="span2">Address<textarea v-model="editor.business_address" maxlength="300" rows="3"></textarea></label><label>VAT / tax ID<input v-model="editor.business_vat_id" maxlength="80"></label><label class="check"><input type="checkbox" v-model="editor.only_show_sats_on_bitcoin">Show sats only on Bitcoin receipts</label><p class="help span2">Receipts and order slips use your browser’s print dialog.</p></div>
    </div>
    <footer class="dialog-footer"><span v-if="error" class="inline-error" role="alert">{{error}}</span><button @click="editor=null">Cancel</button><button class="primary" @click="save" :disabled="busy">{{busy?'Saving…':'Save terminal'}}</button></footer>
  </section></div>

  <div v-if="share" class="overlay"><section class="dialog" role="dialog" aria-modal="true" aria-label="Share terminal"><header class="dialog-header"><h2>Share {{share.terminal.name}}</h2><button class="quiet" @click="share=null" aria-label="Close">×</button></header><div class="dialog-body"><img class="qr small-qr" :src="shareQr" alt="Cashier link QR code"><label>Staff counter link<input readonly :value="share.url" @focus="$event.target.select()"></label><p class="help">Anyone with this link can create checkouts and view this terminal’s recent receipts. Share it with staff.</p><template v-if="share.terminal.remote_enabled"><label>Customer display link<input readonly :value="share.display" @focus="$event.target.select()"></label><button @click="open(share.display)">Open customer display ↗</button></template></div></section></div>

  <div v-if="invoice" :class="terminal?.role==='display'?'display-checkout':'overlay'"><section class="dialog checkout-dialog" role="dialog" aria-label="Checkout">
    <header class="dialog-header"><h2>{{invoice.status==='paid'?'Payment received':invoice.status==='failed'?'Payment expired or failed':'Complete payment'}}</h2><button v-if="terminal?.role!=='display'" class="quiet" @click="closeCheckout" aria-label="Close checkout">×</button></header>
    <div class="dialog-body payment-body"><p v-if="error" class="inline-error" role="alert">{{error}}</p><div v-if="invoice.status==='paid'" class="paid-icon">✓</div><span class="badge" :class="invoice.status==='paid'?'green':'muted'">{{invoice.method==='lightning'?'LIGHTNING':'CARD CHECKOUT'}}</span><div class="payment-total">{{money(invoice.sale.total_minor,invoice.sale.currency)}}</div><p v-if="invoice.method==='lightning'&&invoice.sale.currency!=='sat'" class="subtle">{{invoice.amount_sat.toLocaleString()}} sats</p>
      <template v-if="invoice.status==='pending'"><img v-if="invoiceQr" class="qr" :src="invoiceQr" :alt="invoice.method==='lightning'?'Lightning invoice QR code':'Card checkout QR code'"><p>Scan to pay. This screen updates when payment is confirmed.</p><input readonly class="invoice-text" :value="invoice.payment_request" @focus="$event.target.select()" aria-label="Payment request"><button v-if="invoice.method==='fiat'" @click="open(invoice.payment_request)" :disabled="busy">Open checkout ↗</button></template>
      <p v-if="invoice.status==='creating'" class="help">The provider has not confirmed this checkout. Check with the terminal owner before paying again.</p>
      <p v-if="invoice.status==='paid'">Thank you for your purchase.</p><p v-if="invoice.status==='failed'">Payment was not confirmed. Check the sale before starting again.</p>
      <div v-if="terminal?.role!=='display'" class="row wrap"><button @click="print(invoice,true)" :disabled="busy">Print order</button><button v-if="invoice.status==='paid'" @click="print(invoice)" :disabled="busy">Print receipt</button><button v-if="invoice.status==='paid'||invoice.status==='failed'" class="primary" @click="closeCheckout">{{receiptOnly?'Close receipt':'Next sale →'}}</button><button v-else @click="poll" :disabled="busy">Check status</button></div>
    </div>
  </section></div>

  <div v-if="showHistory||showHeld" class="overlay"><section class="dialog" role="dialog" aria-modal="true" aria-label="Saved sales"><header class="dialog-header"><h2>{{showHeld?'Held carts':'Recent sales'}}</h2><button class="quiet" @click="showHistory=false;showHeld=false" aria-label="Close">×</button></header><div class="dialog-body"><template v-if="showHeld"><p v-if="!held.length" class="help">No held carts on this device.</p><div class="list-row" v-for="c in held" :key="c.id"><span>{{c.name}}</span><button @click="resume(c.id)" :disabled="busy">Resume</button><button class="quiet danger" @click="removeHeld(c.id)" :disabled="busy">Remove</button></div></template><template v-else><p v-if="!history.length" class="help">No sales yet.</p><button class="list-row history-row" v-for="c in history" :key="c.id" @click="viewReceipt(c)"><span>{{timestamp(c.created_at)}}<small>{{c.method}} · {{c.status}}</small></span><strong>{{money(c.sale.total_minor,c.sale.currency)}}</strong></button></template></div></section></div>

  <div v-if="sales" class="overlay"><section class="dialog wide" role="dialog" aria-modal="true" aria-label="Terminal sales"><header class="dialog-header"><div><p class="eyebrow">{{salesTerminal.name}}</p><h2>Sales & receipts</h2></div><button class="quiet" @click="sales=null" aria-label="Close">×</button></header><div class="dialog-body"><div class="row between"><span class="subtle">{{sales.total}} checkouts</span><button @click="exportSales" :disabled="busy">Export this page</button></div><div class="table-scroll"><table><thead><tr><th>Date</th><th>Total</th><th>Method</th><th>Status / shares</th><th>Actions</th></tr></thead><tbody><tr v-for="c in sales.rows" :key="c.id"><td>{{timestamp(c.created_at)}}</td><td>{{money(c.sale.total_minor,c.sale.currency)}}</td><td>{{c.method}}</td><td>{{c.status}}<small v-for="(p,k) in c.payouts" :key="k">{{k}}: {{p.state}} · {{p.amount_sat}} sats</small></td><td><div class="row wrap"><button @click="reconcile(c)" :disabled="busy">Check</button><button @click="print(c)" :disabled="busy||c.status!=='paid'">Receipt</button></div></td></tr></tbody></table></div><p class="help">Shares marked “review” or “pending” need checking in the wallet. PoS never resends an uncertain payment automatically.</p><p v-if="error" role="alert" class="inline-error">{{error}}</p></div><footer class="dialog-footer"><button @click="pageSales(-50)" :disabled="busy||offset===0">Previous</button><span>{{offset+1}}–{{offset+sales.rows.length}}</span><button @click="pageSales(50)" :disabled="busy||offset+50>=sales.total">Next</button></footer></section></div>
  <div v-if="confirmation" class="overlay confirm-overlay"><section class="dialog" role="dialog" aria-modal="true" aria-label="Confirm action"><div class="dialog-body"><p>{{confirmation.message}}</p></div><footer class="dialog-footer"><button @click="answer(false)">Cancel</button><button class="primary" @click="answer(true)">Confirm</button></footer></section></div>
</main>
</template>

<style>
.confirm-overlay{z-index:40}
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-synthesis:none;color:#17261e;background:#f5f7f5}*{box-sizing:border-box}body{margin:0}button,input,select,textarea{font:inherit}button{cursor:pointer;border:1px solid var(--border);border-radius:9px;padding:10px 15px;background:var(--surface);color:var(--text);font-size:14px;font-weight:550;transition:background .12s,border-color .12s}button:hover{background:var(--soft);border-color:#87aa95}button:disabled{opacity:.45;cursor:not-allowed}button:focus-visible,input:focus,select:focus,textarea:focus{outline:3px solid #91c6ab;outline-offset:2px}.pos{--bg:#f5f7f5;--surface:#fff;--soft:#edf3ee;--border:#dce5de;--text:#17261e;--muted:#6b7b70;--accent:#176d43;--accent-text:#fff;min-height:100vh;background:var(--bg);color:var(--text);padding-bottom:36px}.pos.dark{--bg:#111a15;--surface:#1b2820;--soft:#24382b;--border:#344a3c;--text:#e4eee7;--muted:#9ab3a3;--accent:#8fd5aa;--accent-text:#12291b}h1,h2,h3,p{margin:0}h1{font-size:32px;letter-spacing:-1px}h2{font-size:21px;letter-spacing:-.4px}h3{font-size:16px}p{line-height:1.55}small{display:block;color:var(--muted);font-size:12px;line-height:1.5}.topbar{min-height:90px;border-bottom:1px solid var(--border);padding:20px 36px;background:var(--surface);display:flex;justify-content:space-between;align-items:center;gap:16px}.brand{display:flex;align-items:center;gap:12px}.brand strong{font-size:24px;letter-spacing:-.7px}.brand-mark{display:grid;place-items:center;background:var(--accent);color:var(--accent-text);width:44px;height:44px;border-radius:13px;font-size:28px;font-weight:700}.toolbar,.row{display:flex;align-items:center;gap:10px}.between{justify-content:space-between}.wrap{flex-wrap:wrap}.grow{flex:1}.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}.primary:hover{filter:brightness(1.1);background:var(--accent)}.quiet{border-color:transparent;background:transparent;padding:6px 8px}.danger{color:#c24c41}.banner{padding:12px 18px;margin:18px 36px;border-radius:10px;display:flex;justify-content:space-between;align-items:center}.error{background:#fff0ed;color:#9e382d;border:1px solid #edbeb7}.success{background:#e6f4eb;color:#1e6941}.inline-error{color:#b74b3c;font-size:13px;flex:1}.dashboard{max-width:1400px;margin:0 auto;padding:36px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:28px}.section-heading p:not(.eyebrow){color:var(--muted);margin-top:10px}.eyebrow{font-size:11px;font-weight:700;letter-spacing:1.7px;color:var(--muted);margin-bottom:8px}.count{background:var(--soft);border:1px solid var(--border);font-size:12px;border-radius:20px;padding:5px 10px;white-space:nowrap}.card{background:var(--surface);border:1px solid var(--border);border-radius:16px}.terminal-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:20px}.terminal-card{padding:22px}.terminal-card h2{margin-top:20px}.terminal-card p{color:var(--muted);font-size:14px;margin-top:6px}.terminal-icon{width:42px;height:42px;background:var(--soft);display:grid;place-items:center;border-radius:12px;font-size:25px;color:var(--accent)}.badge{font-size:10px;font-weight:700;letter-spacing:.6px;padding:5px 9px;border-radius:5px}.green{color:#216544;background:#e3f3e8}.muted{color:var(--muted);background:var(--soft)}.tags{display:flex;gap:7px;margin:18px 0 22px}.tags span{font-size:11px;padding:5px 8px;border:1px solid var(--border);border-radius:5px;color:var(--muted)}.card-actions{display:flex;gap:8px}.card-actions .primary{flex:1}.secondary-actions{border-top:1px solid var(--border);margin-top:18px;padding-top:10px;gap:2px}.secondary-actions button{font-size:12px}.empty{text-align:center;padding:70px 20px;color:var(--muted)}.empty h2,.empty h3{color:var(--text);margin:16px 0 8px}.empty button{margin-top:20px}.large-icon{font-size:42px;color:var(--accent)}.compact{padding:40px 10px}.counter{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:28px;max-width:1600px;margin:0 auto;padding:28px 36px}.catalog{min-width:0}.segmented{display:inline-flex;background:var(--soft);border-radius:10px;padding:4px;gap:3px}.segmented button{background:transparent;border-color:transparent}.segmented button.selected{background:var(--surface);border-color:var(--border)}.currency-label{font-size:12px;font-weight:700;letter-spacing:1px;color:var(--muted)}input,select,textarea{width:100%;border:1px solid var(--border);background:var(--surface);color:var(--text);padding:10px 12px;border-radius:8px;font-size:14px;min-width:0}input::placeholder,textarea::placeholder{color:var(--muted)}textarea{resize:vertical}.search{margin-top:24px;padding:14px 16px}.categories{display:flex;gap:8px;overflow:auto;padding:16px 0 22px}.categories button{white-space:nowrap;border-radius:20px;padding:6px 14px;font-size:12px}.selected{color:var(--accent);border-color:var(--accent)}.product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px}.product{display:flex;align-items:flex-start;flex-direction:column;text-align:left;padding:16px;min-height:176px;border-radius:13px}.product strong{margin-top:14px;font-size:14px}.product-letter{height:44px;width:44px;display:grid;place-items:center;font-size:23px;font-weight:500;border-radius:12px;background:var(--soft);color:var(--accent)}.product img{width:100%;height:82px;object-fit:contain}.product small{margin-top:4px}.product .price{color:var(--accent);font-size:14px;margin-top:auto;padding-top:15px;font-weight:650}.cart{padding:22px;display:flex;flex-direction:column;align-self:start}.cart-lines{max-height:48vh;overflow:auto;min-height:160px}.cart-line{padding:18px 0;border-bottom:1px solid var(--border)}.cart-line .row{margin-bottom:8px}.cart-line .quantity{max-width:65px}.cart-line>input{font-size:12px;padding:6px 9px}.cart-footer{padding-top:18px}.cart-footer>.row{margin-top:10px}.subtle{color:var(--muted);font-size:13px}.totals{padding:18px 0}.totals>div{display:flex;justify-content:space-between;font-size:13px;gap:12px;margin-bottom:8px;color:var(--muted)}.totals .total{font-size:21px;color:var(--text);margin-top:14px;margin-bottom:0}.pay-button{width:100%;padding:14px;margin-bottom:8px}.tip-box{margin-top:18px;padding:14px 0;border-bottom:1px solid var(--border)}.tip-box .row{margin-bottom:8px}.tip-box input{max-width:145px}.tip-box button{font-size:12px;padding:7px 10px}.tip-box strong{font-size:13px}.keypad{max-width:400px;margin:40px auto}.keypad-value{text-align:right;padding:28px 12px;font-size:42px;letter-spacing:-1px;overflow-wrap:anywhere}.keypad-value small{display:inline;font-size:16px}.keypad-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}.keypad-grid button{padding:22px;font-size:26px;border-radius:12px}.overlay{position:fixed;inset:0;background:#07170fc2;z-index:30;display:flex;justify-content:center;align-items:center;padding:24px}.dialog{background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:18px;width:100%;max-width:520px;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 20px 70px #0003}.dialog.wide{max-width:850px}.dialog-header{padding:22px 26px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);gap:12px}.dialog-header>.quiet{font-size:25px;line-height:1}.dialog-body{padding:24px 26px;overflow:auto}.dialog-footer{padding:16px 26px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;align-items:center;gap:10px;flex-wrap:wrap}.dialog-tabs{display:flex;gap:20px;padding:12px 26px 0;border-bottom:1px solid var(--border)}.dialog-tabs button{border:0;border-radius:0;background:none;padding:12px 0;border-bottom:2px solid transparent}.dialog-tabs button.selected{border-bottom-color:var(--accent)}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.span2{grid-column:span 2}label{display:flex;flex-direction:column;gap:7px;font-size:12px;font-weight:650}.check{flex-direction:row;align-items:center;font-size:13px;font-weight:450}.check input{width:17px;height:17px;accent-color:var(--accent)}.form-section{border-top:1px solid var(--border);padding-top:20px;margin-top:4px}.form-section h3{margin-bottom:12px}.help{font-size:12px;color:var(--muted);line-height:1.6}.product-editor{padding:18px;border:1px solid var(--border);border-radius:12px;margin:16px 0}.product-editor>.row{margin-bottom:14px}.import-box{border-top:1px solid var(--border);padding-top:18px;margin-top:22px;font-size:13px}.import-box summary{cursor:pointer;font-weight:650}.import-box p,.import-box textarea,.import-box input{margin:12px 0}.qr{display:block;max-width:100%;width:300px;margin:16px auto;border-radius:12px;background:white;padding:8px}.small-qr{width:240px}.payment-body{text-align:center;display:flex;align-items:center;flex-direction:column;gap:12px}.payment-total{font-size:38px;font-weight:700;letter-spacing:-1.2px;margin-top:8px}.invoice-text{font-size:11px}.paid-icon{border-radius:50%;width:86px;height:86px;background:#e3f3e8;color:#176d43;font-size:55px;display:grid;place-items:center;margin:12px}.display-welcome{min-height:70vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;text-align:center;padding:30px}.display-welcome .brand-mark{height:80px;width:80px;font-size:50px;border-radius:22px}.display-checkout{display:flex;justify-content:center;padding:32px}.display-checkout .dialog{box-shadow:none;max-height:none}.list-row{display:flex;align-items:center;gap:10px;padding:14px 0;border-bottom:1px solid var(--border)}.list-row>span{flex:1}.history-row{width:100%;justify-content:space-between;text-align:left;border-radius:0;border-left:0;border-right:0;border-top:0}.table-scroll{overflow:auto;margin:20px 0}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.6px}td,th{padding:14px 10px;border-bottom:1px solid var(--border)}td button{font-size:11px;padding:6px 8px}.loader{display:inline-block;width:24px;height:24px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:1000px){.counter{grid-template-columns:minmax(0,1fr) 340px;padding:22px;gap:20px}.topbar{padding:18px 22px}.dashboard{padding:28px 22px}.cart{padding:16px}}@media(max-width:700px){.topbar{align-items:flex-start;flex-direction:column;padding:18px}.toolbar{width:100%;justify-content:flex-end}.brand strong{font-size:22px}.counter{grid-template-columns:1fr;padding:18px}.product-grid{grid-template-columns:repeat(2,1fr)}.product{min-height:145px}.cart-lines{max-height:none}.dashboard{padding:26px 18px}.section-heading{align-items:flex-start}h1{font-size:28px}.terminal-grid{grid-template-columns:1fr}.overlay{padding:10px}.dialog{max-height:96vh;border-radius:13px}.dialog-body,.dialog-header{padding:18px}.dialog-footer{padding:14px 18px}.form-grid{grid-template-columns:1fr}.span2{grid-column:auto}.banner{margin:12px 18px}.dialog-tabs{gap:15px;padding-left:18px}.payment-total{font-size:32px}.display-checkout{padding:18px}}
</style>
