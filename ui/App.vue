<script setup>
import {ref,computed,onMounted,onBeforeUnmount} from 'vue';
import QRCode from 'qrcode';
import {createBridge} from './bridge.js';
import {cartStorage,checkoutSession} from './storage.js';
import {applyCoreTheme} from './theme.js';
import {calculateSale,decimal,minor,digits} from '../src/domain.js';

const bridge=createBridge(),local=cartStorage(bridge);
const loading=ref(true),busy=ref(false),error=ref(''),notice=ref(''),isPublic=ref(false),link=ref('');
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
onMounted(async()=>{
  try {
    const context=await bridge.request('context');isPublic.value=context.public;applyCoreTheme(context.theme);link.value=context.routeParams?.link||'';
    unsubscribe=bridge.onEvent(e=>{if(e.event==='ui.theme')applyCoreTheme(e.data);if(e.event==='websocket.message')poll();});
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
<main class="q-pa-md">
  <header class="row items-center justify-between q-gutter-md q-mb-lg">
    <div class="row items-center no-wrap q-gutter-sm">
      <q-icon name="point_of_sale" color="primary" size="md" />
      <div>
        <div class="text-h5">{{isPublic ? terminal?.name || 'Bolt Till' : 'Bolt Till'}}</div>
        <div class="text-caption">{{isPublic ? terminal?.role==='display' ? 'Customer display · Bolt Till' : 'Powered by Bolt Till' : 'Your Bitcoin counter.'}}</div>
      </div>
    </div>
    <div v-if="!loading" class="row q-gutter-sm">
      <template v-if="!isPublic">
        <q-btn flat label="Export CSV" @click="exportTerminals" :disable="busy||!terminals.length" />
        <q-btn color="primary" icon="add" label="New terminal" @click="edit()" :disable="busy" />
      </template>
      <template v-else-if="terminal?.role==='cashier'">
        <q-btn flat label="Recent sales" @click="recent" :disable="busy" />
        <q-btn flat label="Held carts" @click="heldCarts" :disable="busy||!!cashierAttempt" />
      </template>
    </div>
  </header>
  <q-banner v-if="error" role="alert" class="bg-negative text-white q-mb-md" inline-actions>
    {{error}}<template #action><q-btn flat round icon="close" @click="error=''" aria-label="Dismiss error" /></template>
  </q-banner>
  <q-banner v-if="notice" role="status" class="bg-positive text-white q-mb-md">{{notice}}</q-banner>
  <div v-if="loading" class="text-center q-pa-xl"><q-spinner color="primary" size="md" /><p>Connecting to LNbits…</p></div>

  <section v-else-if="!isPublic">
    <div class="row items-center justify-between q-mb-md">
      <div><h1 class="text-h6 q-my-sm">Your terminals</h1><p>Share a counter link with staff. Keep wallet settings here.</p></div>
      <q-badge color="primary">{{terminals.filter(t=>t.active).length}} active</q-badge>
    </div>
    <q-card v-if="!terminals.length"><q-card-section class="text-center q-pa-xl">
      <q-icon name="point_of_sale" size="xl" color="primary" />
      <h2 class="text-h6">Open your first counter</h2><p>Choose a wallet, add your products, and start taking payments.</p>
      <q-btn color="primary" label="Create a terminal" @click="edit()" :disable="busy" />
    </q-card-section></q-card>
    <div class="terminal-grid">
      <q-card v-for="t in terminals" :key="t.id">
        <q-card-section>
          <div class="row justify-between"><q-icon name="point_of_sale" size="md" color="primary" /><q-badge :color="t.active?'positive':'grey'">{{t.active?'Active':'Disabled'}}</q-badge></div>
          <h2 class="text-h6 q-mb-xs">{{t.name}}</h2><p>{{t.currency==='sat'?'Priced in sats':t.currency}} · {{t.product_count}} products</p>
          <div class="row q-gutter-xs"><q-chip dense icon="bolt">Lightning</q-chip><q-chip v-if="t.provider" dense>{{t.provider}}</q-chip><q-chip v-if="t.tips_enabled" dense>Tips</q-chip></div>
        </q-card-section>
        <q-card-actions>
          <q-btn color="primary" label="Open counter" icon-right="open_in_new" @click="open(terminalUrl(t.cashier_link))" :disable="!t.active||busy" />
          <q-btn flat label="Share" @click="shareTerminal(t)" :disable="!t.active||busy" />
        </q-card-actions>
        <q-separator />
        <q-card-actions>
          <q-btn flat label="Edit" @click="edit(t)" :disable="busy" />
          <q-btn flat label="Sales" @click="showSales(t)" :disable="busy" />
          <q-btn v-if="t.tip_wallet||t.revenue_address" flat label="Payment permission" @click="background(t)" :disable="busy" />
          <q-btn flat label="Replace links" @click="rotate(t)" :disable="busy" />
          <q-btn v-if="t.active" flat color="negative" label="Disable" @click="disable(t)" :disable="busy" />
        </q-card-actions>
      </q-card>
    </div>
  </section>

  <section v-else-if="terminal?.role==='cashier'" class="counter">
    <div>
      <q-tabs v-model="view" active-color="primary" align="left" class="q-mb-md"><q-tab name="products" label="Products" /><q-tab name="keypad" label="Keypad" /></q-tabs>
      <template v-if="view==='products'">
        <q-input filled dense v-model="search" label="Search products" class="q-mb-md"><template #prepend><q-icon name="search" /></template></q-input>
        <div class="row q-gutter-xs q-mb-md">
          <q-btn :flat="!!category" :color="!category?'primary':undefined" label="All" @click="category=''" />
          <q-btn v-for="c in categories" :key="c" :flat="category!==c" :color="category===c?'primary':undefined" :label="c" @click="category=c" />
        </div>
        <div class="product-grid">
          <q-btn v-for="p in products" :key="p.id" outline no-caps class="product-button" @click="add(p)" :disable="!!cashierAttempt">
            <div class="column items-center q-gutter-xs">
              <img v-if="p.image" class="product-image" :src="p.image" alt="">
              <strong>{{p.title}}</strong><span v-if="p.description" class="text-caption">{{p.description}}</span>
              <span>{{p.price}} {{currentCurrency==='sat'?'sats':currentCurrency}}</span>
            </div>
          </q-btn>
        </div>
        <div v-if="!products.length" class="text-center q-pa-xl"><h3 class="text-h6">No products here yet</h3><p>Use the keypad to enter an amount.</p><q-btn flat color="primary" label="Open keypad" @click="view='keypad'" /></div>
      </template>
      <div v-else class="keypad">
        <div class="text-h4 text-right q-py-lg">{{keypad||'0'}} <span class="text-subtitle1">{{currentCurrency==='sat'?'sats':currentCurrency}}</span></div>
        <div class="keypad-grid q-mb-sm"><q-btn v-for="key in ['1','2','3','4','5','6','7','8','9','C','0','.']" :key="key" outline size="lg" :label="key" @click="press(key)" :disable="!!cashierAttempt" /></div>
        <div class="row q-gutter-sm"><q-btn outline icon="backspace" aria-label="Backspace" @click="press('⌫')" :disable="!!cashierAttempt" /><q-btn color="primary" class="col" label="Add to cart" icon="add" @click="addCustom" :disable="!!cashierAttempt" /></div>
      </div>
    </div>
    <q-card class="cart">
      <q-card-section class="row items-center justify-between"><h2 class="text-h6 q-ma-none">Current sale</h2><q-badge color="primary">{{items.reduce((s,l)=>s+l.quantity,0)}} items</q-badge></q-card-section>
      <q-separator />
      <q-card-section>
        <p v-if="!items.length" class="text-center q-py-lg">Add products or enter an amount.</p>
        <div v-for="(line,i) in items" :key="i" class="q-mb-md">
          <div class="row items-center justify-between"><strong>{{title(line)}}</strong><q-btn flat round dense color="negative" icon="close" @click="items.splice(i,1)" :disable="!!cashierAttempt" :aria-label="'Remove '+title(line)" /></div>
          <div class="row no-wrap q-gutter-sm q-mb-sm">
            <q-input filled dense type="number" min="1" max="999" v-model.number="line.quantity" class="quantity" label="Quantity" :disable="!!cashierAttempt" />
            <q-input filled dense :model-value="price(line)" @update:model-value="line.price=$event" label="Unit price" :suffix="currentCurrency" inputmode="decimal" class="col" :disable="!!cashierAttempt||!!line.product_id&&!terminal.allow_price_adjustment" />
          </div>
          <q-input filled dense v-model="line.note" label="Item note" maxlength="160" :disable="!!cashierAttempt" />
        </div>
        <q-input filled dense v-model="note" maxlength="240" label="Sale note (optional)" :disable="!!cashierAttempt" />
        <div v-if="terminal.tips_enabled&&items.length" class="q-mt-md">
          <q-input filled dense v-model="tip" inputmode="decimal" label="Tip amount" :disable="!!cashierAttempt" />
          <div class="row q-gutter-xs q-my-sm"><q-btn v-for="p in terminal.tip_options" :key="p" flat :label="p+'%'" @click="setTip(p)" :disable="!!cashierAttempt" /><q-btn flat label="No tip" @click="tip='0'" :disable="!!cashierAttempt" /></div>
          <div class="row no-wrap q-gutter-sm"><q-input filled dense v-model="rounding" label="Round total to" inputmode="decimal" class="col" :disable="!!cashierAttempt" /><q-btn flat label="Round up" @click="roundTotal" :disable="!!cashierAttempt" /></div>
        </div>
        <div v-if="preview" class="q-mt-md">
          <div class="row justify-between"><span>Subtotal</span><span>{{money(preview.subtotal_minor)}}</span></div>
          <div class="row justify-between"><span>Tax {{preview.tax_inclusive?'(included)':''}}</span><span>{{money(preview.tax_minor)}}</span></div>
          <div v-if="preview.tip_minor" class="row justify-between"><span>Tip</span><span>{{money(preview.tip_minor)}}</span></div>
          <q-separator class="q-my-sm" /><div class="row justify-between text-h6"><span>Total</span><span>{{money(preview.total_minor)}}</span></div>
        </div>
        <q-btn color="primary" icon="bolt" class="full-width q-mt-md" :label="cashierAttempt?'Check / retry this checkout':'Charge with Lightning'" @click="checkout('lightning')" :disable="busy||!preview" />
        <q-btn v-if="terminal.fiat_enabled&&!cashierAttempt" outline class="full-width q-mt-sm" label="Hosted card checkout" @click="checkout('fiat')" :disable="busy||!preview" />
      </q-card-section>
      <q-card-actions align="between"><q-btn flat label="Hold cart" @click="hold" :disable="busy||!items.length||!!cashierAttempt" /><q-btn flat label="Clear" @click="clearCart" :disable="!!cashierAttempt" /></q-card-actions>
    </q-card>
  </section>

  <section v-else-if="terminal?.role==='display'&&!invoice" class="text-center q-pa-xl"><q-icon name="point_of_sale" color="primary" size="xl" /><h1 class="text-h4">Welcome to {{terminal.name}}</h1><p>Your checkout will appear here.</p></section>

  <q-dialog :model-value="!!editor" persistent>
    <q-card v-if="editor" class="wide-dialog">
      <q-card-section class="row items-center justify-between"><h2 class="text-h6 q-ma-none">{{editor.id?'Edit counter':'Create a counter'}}</h2><q-btn flat round dense icon="close" @click="editor=null" aria-label="Close" :disable="busy" /></q-card-section>
      <q-tabs v-model="editorTab" active-color="primary" align="left"><q-tab name="settings" label="Settings" /><q-tab name="products" :label="'Products ('+editor.products.length+')'" /><q-tab name="receipt" label="Receipt" /></q-tabs>
      <q-separator />
      <q-card-section>
        <div v-if="editorTab==='settings'" class="form-grid">
          <q-input filled v-model="editor.name" maxlength="80" label="Terminal name" placeholder="Front counter" />
          <q-select filled v-model="editor.currency" :options="meta.currencies" label="Price currency" />
          <q-select filled v-model="editor.wallet" :options="meta.wallets" option-label="name" option-value="id" emit-value map-options label="Lightning receiving wallet" class="span2" />
          <q-input filled v-model="editor.tax_default" type="number" min="0" max="100" step="0.01" label="Default tax (%)" />
          <q-checkbox v-model="editor.tax_inclusive" label="Prices include tax" />
          <q-checkbox v-model="editor.allow_price_adjustment" label="Allow staff to adjust product prices" />
          <q-checkbox v-model="editor.remote_enabled" label="Enable a separate customer display" />
          <div class="span2"><q-separator class="q-mb-md" /><h3 class="text-subtitle1 q-my-sm">Tips</h3><q-checkbox v-model="editor.tips_enabled" label="Offer tips at checkout" /></div>
          <template v-if="editor.tips_enabled">
            <q-select filled v-model="editor.tip_wallet" :options="[{id:'',name:'Keep tips in receiving wallet'},...meta.wallets]" option-label="name" option-value="id" emit-value map-options label="Tip wallet" />
            <q-input filled :model-value="editor.tip_options.join(', ')" @change="editor.tip_options=$event.split(',').filter(s=>s.trim()).map(Number)" label="Tip percentages" placeholder="10, 15, 20" />
            <p class="text-caption span2">Separate Lightning tips require background-payment permission. Fiat tips stay in the fiat receiving wallet.</p>
          </template>
          <div class="span2"><q-separator class="q-mb-md" /><h3 class="text-subtitle1 q-my-sm">Revenue sharing</h3><p class="text-caption">Forward a percentage of each Lightning sale, excluding tips. Requires payment permission.</p></div>
          <q-input filled v-model="editor.revenue_address" label="Recipient Lightning address" placeholder="name@example.com" maxlength="254" />
          <q-input filled v-model="editor.revenue_percent" type="number" min="0" max="100" step="0.01" label="Share (%)" />
          <div class="span2"><q-separator class="q-mb-md" /><h3 class="text-subtitle1 q-my-sm">Hosted card payments</h3></div>
          <q-select filled v-model="editor.provider" :options="[{label:'Disabled',value:''},...meta.providers.map(p=>({label:p,value:p}))]" emit-value map-options label="Provider" :disable="editor.currency==='sat'" />
          <q-select v-if="editor.provider" filled v-model="editor.fiat_wallet" :options="meta.wallets.filter(w=>w.currency?.toUpperCase()===editor.currency)" option-label="name" option-value="id" emit-value map-options label="Fiat receiving wallet" />
        </div>
        <div v-else-if="editorTab==='products'">
          <div class="row items-center justify-between q-mb-md"><span class="text-caption">Up to 100 products. Leave tax empty to use the default.</span><q-btn flat color="primary" icon="add" label="Add product" @click="addProduct" :disable="editor.products.length>=100" /></div>
          <div v-for="(p,i) in editor.products" :key="p.id" class="q-mb-lg">
            <q-separator class="q-mb-sm" /><div class="row items-center justify-between q-mb-sm"><strong>Product {{i+1}}</strong><q-btn flat color="negative" label="Remove" @click="editor.products.splice(i,1)" /></div>
            <div class="form-grid">
              <q-input filled v-model="p.title" maxlength="80" label="Name" /><q-input filled v-model="p.price" inputmode="decimal" label="Price" />
              <q-input filled v-model="p.category" maxlength="40" label="Category" /><q-input filled v-model="p.tax" type="number" min="0" max="100" step="0.01" label="Tax (%)" placeholder="Default" />
              <q-input filled v-model="p.description" maxlength="240" label="Description" class="span2" /><q-checkbox v-model="p.disabled" label="Hide from counter" />
            </div>
          </div>
          <q-expansion-item label="Import products from JSON" icon="upload_file">
            <div class="q-pa-md"><p class="text-caption">Accepts TPoS product arrays. Import replaces this catalog. Remote image URLs must be removed; small data images are supported.</p>
              <label class="block q-mb-md">Products file <input ref="productFile" type="file" accept="application/json,.json" @change="readProductFile"></label>
              <q-input filled v-model="importText" type="textarea" rows="5" label="Products JSON" placeholder='[{"title":"Coffee","price":2.50}]' class="q-mb-md" />
              <q-btn flat color="primary" label="Import and review" @click="importProducts" />
            </div>
          </q-expansion-item>
        </div>
        <div v-else class="form-grid">
          <q-input filled v-model="editor.business_name" maxlength="120" label="Business name" class="span2" />
          <q-input filled v-model="editor.business_address" maxlength="300" rows="3" type="textarea" label="Address" class="span2" />
          <q-input filled v-model="editor.business_vat_id" maxlength="80" label="VAT / tax ID" /><q-checkbox v-model="editor.only_show_sats_on_bitcoin" label="Show sats only on Bitcoin receipts" />
          <p class="text-caption span2">Receipts and order slips use your browser’s print dialog.</p>
        </div>
        <p v-if="error" class="text-negative q-mt-md" role="alert">{{error}}</p>
      </q-card-section>
      <q-card-actions align="right"><q-btn flat label="Cancel" @click="editor=null" :disable="busy" /><q-btn color="primary" label="Save terminal" @click="save" :loading="busy" /></q-card-actions>
    </q-card>
  </q-dialog>

  <q-dialog :model-value="!!share" @update:model-value="share=null">
    <q-card v-if="share" class="lnbits__dialog-card">
      <q-card-section class="row items-center justify-between"><h2 class="text-h6 q-ma-none">Share {{share.terminal.name}}</h2><q-btn flat round dense icon="close" @click="share=null" aria-label="Close" /></q-card-section>
      <q-card-section>
        <img class="qr small-qr q-mb-md" :src="shareQr" alt="Cashier link QR code">
        <q-input filled readonly :model-value="share.url" label="Staff counter link" @focus="$event.target.select()" />
        <p class="text-caption q-mt-sm">Anyone with this link can create checkouts and view this terminal’s recent receipts. Share it with staff.</p>
        <template v-if="share.terminal.remote_enabled"><q-input filled readonly :model-value="share.display" label="Customer display link" @focus="$event.target.select()" /><q-btn flat color="primary" icon-right="open_in_new" label="Open customer display" class="q-mt-sm" @click="open(share.display)" /></template>
      </q-card-section>
    </q-card>
  </q-dialog>

  <q-dialog :model-value="!!invoice" persistent>
    <q-card v-if="invoice" class="lnbits__dialog-card">
      <q-card-section class="row items-center justify-between">
        <h2 class="text-h6 q-ma-none">{{invoice.status==='paid'?'Payment received':invoice.status==='failed'?'Payment expired or failed':'Complete payment'}}</h2>
        <q-btn v-if="terminal?.role!=='display'" flat round dense icon="close" @click="closeCheckout" aria-label="Close checkout" />
      </q-card-section>
      <q-card-section class="text-center">
        <p v-if="error" class="text-negative" role="alert">{{error}}</p>
        <div v-if="invoice.status==='paid'" class="q-mb-md"><q-icon name="check_circle" color="positive" size="xl" /></div>
        <q-badge :color="invoice.status==='paid'?'positive':'primary'">{{invoice.method==='lightning'?'LIGHTNING':'CARD CHECKOUT'}}</q-badge>
        <div class="text-h4 q-my-md">{{money(invoice.sale.total_minor,invoice.sale.currency)}}</div>
        <p v-if="invoice.method==='lightning'&&invoice.sale.currency!=='sat'">{{invoice.amount_sat.toLocaleString()}} sats</p>
        <template v-if="invoice.status==='pending'">
          <img v-if="invoiceQr" class="qr q-mb-md" :src="invoiceQr" :alt="invoice.method==='lightning'?'Lightning invoice QR code':'Card checkout QR code'">
          <p>Scan to pay. This screen updates when payment is confirmed.</p>
          <q-input filled dense readonly :model-value="invoice.payment_request" label="Payment request" @focus="$event.target.select()" />
          <q-btn v-if="invoice.method==='fiat'" flat color="primary" icon-right="open_in_new" label="Open checkout" class="q-mt-md" @click="open(invoice.payment_request)" :disable="busy" />
        </template>
        <p v-if="invoice.status==='creating'">The provider has not confirmed this checkout. Check with the terminal owner before paying again.</p>
        <p v-if="invoice.status==='paid'">Thank you for your purchase.</p><p v-if="invoice.status==='failed'">Payment was not confirmed. Check the sale before starting again.</p>
      </q-card-section>
      <q-card-actions v-if="terminal?.role!=='display'" align="center">
        <q-btn flat label="Print order" @click="print(invoice,true)" :disable="busy" /><q-btn v-if="invoice.status==='paid'" flat label="Print receipt" @click="print(invoice)" :disable="busy" />
        <q-btn v-if="invoice.status==='paid'||invoice.status==='failed'" color="primary" :label="receiptOnly?'Close receipt':'Next sale'" @click="closeCheckout" /><q-btn v-else flat label="Check status" @click="poll" :disable="busy" />
      </q-card-actions>
    </q-card>
  </q-dialog>

  <q-dialog :model-value="showHistory||showHeld" @update:model-value="showHistory=false;showHeld=false">
    <q-card class="lnbits__dialog-card">
      <q-card-section class="row items-center justify-between"><h2 class="text-h6 q-ma-none">{{showHeld?'Held carts':'Recent sales'}}</h2><q-btn flat round dense icon="close" @click="showHistory=false;showHeld=false" aria-label="Close" /></q-card-section>
      <q-card-section>
        <q-list v-if="showHeld" separator>
          <p v-if="!held.length">No held carts on this device.</p>
          <q-item v-for="c in held" :key="c.id"><q-item-section>{{c.name}}</q-item-section><q-item-section side><div class="row"><q-btn flat label="Resume" @click="resume(c.id)" :disable="busy" /><q-btn flat color="negative" label="Remove" @click="removeHeld(c.id)" :disable="busy" /></div></q-item-section></q-item>
        </q-list>
        <q-list v-else separator>
          <p v-if="!history.length">No sales yet.</p>
          <q-item v-for="c in history" :key="c.id" clickable @click="viewReceipt(c)" :disable="busy"><q-item-section><q-item-label>{{timestamp(c.created_at)}}</q-item-label><q-item-label caption>{{c.method}} · {{c.status}}</q-item-label></q-item-section><q-item-section side>{{money(c.sale.total_minor,c.sale.currency)}}</q-item-section></q-item>
        </q-list>
      </q-card-section>
    </q-card>
  </q-dialog>

  <q-dialog :model-value="!!sales" @update:model-value="sales=null">
    <q-card v-if="sales" class="wide-dialog">
      <q-card-section class="row items-center justify-between"><div><div class="text-caption">{{salesTerminal.name}}</div><h2 class="text-h6 q-ma-none">Sales &amp; receipts</h2></div><q-btn flat round dense icon="close" @click="sales=null" aria-label="Close" /></q-card-section>
      <q-card-section>
        <div class="row items-center justify-between q-mb-md"><span>{{sales.total}} checkouts</span><q-btn flat label="Export this page" @click="exportSales" :disable="busy" /></div>
        <q-markup-table flat>
          <thead><tr><th class="text-left">Date</th><th class="text-left">Total</th><th class="text-left">Method</th><th class="text-left">Status / shares</th><th class="text-left">Actions</th></tr></thead>
          <tbody><tr v-for="c in sales.rows" :key="c.id"><td>{{timestamp(c.created_at)}}</td><td>{{money(c.sale.total_minor,c.sale.currency)}}</td><td>{{c.method}}</td><td>{{c.status}}<div v-for="(p,k) in c.payouts" :key="k" class="text-caption">{{k}}: {{p.state}} · {{p.amount_sat}} sats</div></td><td><q-btn flat label="Check" @click="reconcile(c)" :disable="busy" /><q-btn flat label="Receipt" @click="print(c)" :disable="busy||c.status!=='paid'" /></td></tr></tbody>
        </q-markup-table>
        <p class="text-caption q-mt-md">Shares marked “review” or “pending” need checking in the wallet. Bolt Till never resends an uncertain payment automatically.</p><p v-if="error" role="alert" class="text-negative">{{error}}</p>
      </q-card-section>
      <q-card-actions align="right"><q-btn flat label="Previous" @click="pageSales(-50)" :disable="busy||offset===0" /><span>{{sales.rows.length?offset+1:0}}–{{offset+sales.rows.length}}</span><q-btn flat label="Next" @click="pageSales(50)" :disable="busy||offset+50>=sales.total" /></q-card-actions>
    </q-card>
  </q-dialog>
  <q-dialog :model-value="!!confirmation" persistent>
    <q-card v-if="confirmation" class="lnbits__dialog-card"><q-card-section>{{confirmation.message}}</q-card-section><q-card-actions align="right"><q-btn flat label="Cancel" @click="answer(false)" /><q-btn color="primary" label="Confirm" @click="answer(true)" /></q-card-actions></q-card>
  </q-dialog>
</main>
</template>

<style>
/* Layout only. Core's Quasar and LNbits styles own the appearance. */
.terminal-grid {display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr));gap:16px}
.counter {display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,380px);gap:24px;align-items:start}
.product-grid {display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px}
.product-button {min-height:120px;overflow-wrap:anywhere}
.product-image {width:100%;height:100px;object-fit:contain}
.keypad {max-width:400px;margin:auto}
.keypad-grid {display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.quantity {width:95px;flex-shrink:0}
.cart {min-width:0}
.form-grid {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.span2 {grid-column:1/-1}
.q-dialog .wide-dialog {width:780px;max-width:calc(100vw - 32px)}
.qr {display:block;width:360px;max-width:100%;height:auto;margin-left:auto;margin-right:auto}
.small-qr {width:260px}
@media(max-width:800px) {.counter {grid-template-columns:1fr}}
@media(max-width:500px) {.form-grid {grid-template-columns:1fr}}
</style>
