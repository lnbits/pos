<script setup>
import {ref,computed,watch,onMounted,onBeforeUnmount} from 'vue';
import QRCode from 'qrcode';
import {createBridge} from './bridge.js';
import {cartStorage,checkoutSession,appearanceStorage} from './storage.js';
import {applyCoreTheme} from './theme.js';
import {calculateSale,decimal,minor,productCategories} from '../src/domain.js';
import {keypadAmount,keypadShortcut} from './keypad.js';
import {createCheckoutCompletion,receiptRate,currentFiatValue} from './receipt.js';

const bridge=createBridge(),local=cartStorage(bridge),appearance=appearanceStorage(bridge);
const loading=ref(true),busy=ref(false),error=ref(''),notice=ref(''),isPublic=ref(false),link=ref('');
const terminals=ref([]),meta=ref({wallets:[],currencies:['sat'],providers:[]}),editor=ref(null);
const expanded=ref([]),catalog=ref(null),itemEditor=ref(null),showImport=ref(false);
const terminalColumns=[{name:'actions',label:'',field:'id',align:'left'},{name:'name',label:'Name',field:'name',align:'left'},{name:'currency',label:'Currency',field:'currency',align:'left'},{name:'provider',label:'Fiat Provider',field:'provider',align:'left'},{name:'revenue_address',label:'LNaddress',field:'revenue_address',align:'left'},{name:'revenue_percent',label:'LNaddress Cut',field:'revenue_percent',align:'left'}];
const terminal=ref(null),items=ref([]),note=ref(''),tip=ref('0'),search=ref(''),category=ref(''),view=ref('products'),keypad=ref(''),history=ref([]),showHistory=ref(false),held=ref([]),showHeld=ref(false);
const invoice=ref(null),invoiceQr=ref(''),share=ref(null),shareQr=ref(''),sales=ref(null),offset=ref(0),salesTerminal=ref(null),importText=ref('');
const rounding=ref(''),cashierAttempt=ref(null);
const confirmation=ref(null),receiptOnly=ref(false);
const printPrompt=ref(null),fullscreen=ref(false),fullscreenAvailable=ref(false);
const completeCheckout=createCheckoutCompletion();
const showHold=ref(false),holdNote=ref(''),importMode=ref('append'),historyRates=ref({}),salesRates=ref({});
const cartDrawer=ref(false),listView=ref(false),mono=ref(false),showNote=ref(false),showTips=ref(false),showMethods=ref(false),showRound=ref(false),pendingMethod=ref(null),lineEditor=ref(null);
const tileSize=ref(160);
const keypadValue=computed(()=>keypadAmount(keypad.value,currentCurrency.value));
let previousCheckout=null,activeCheckoutId='';
let timer,unsubscribe,session,polling=false,qrSequence=0;
let appearanceReady=false;
watch([mono,tileSize],()=>{
  if(appearanceReady)appearance.save({mono:mono.value,tileSize:tileSize.value}).catch(()=>{notice.value='Could not save appearance on this device.';});
});
function ask(message){return new Promise(resolve=>{confirmation.value={message,resolve};});}
function answer(value){confirmation.value?.resolve(value);confirmation.value=null;}

const categories=computed(()=>[...new Set((terminal.value?.products||[]).filter(p=>!p.disabled).flatMap(productCategories))]);
const catalogCategories=computed(()=>[...new Set((catalog.value?.products||[]).flatMap(productCategories))]);
const products=computed(()=>(terminal.value?.products||[]).filter(p=>!p.disabled&&(!category.value||productCategories(p).includes(category.value))&&(`${p.title} ${p.description}`).toLowerCase().includes(search.value.toLowerCase())));
const preview=computed(()=>{
  if(!terminal.value || !items.value.length)return null;
  try{return calculateSale(terminal.value,{items:items.value,tip:tip.value,note:note.value});}catch{return null;}
});
const currentCurrency=computed(()=>terminal.value?.currency||'sat');
const lightningWallets=computed(()=>meta.value.wallets.filter(w=>['lightning','lightning-shared'].includes(w.wallet_type)));
const onchainWallets=computed(()=>meta.value.wallets.filter(w=>w.wallet_type==='onchain').map(w=>({...w,label:`${w.name} (${w.onchain_network||'not configured'})${w.receiving_ready?'':' — not ready'}`,disable:!w.receiving_ready})));
function money(value,currency=currentCurrency.value){return `${decimal(value,currency)} ${currency==='sat'?'sats':currency}`;}
function timestamp(value){return new Date(value*1000).toLocaleString();}
function clone(value){return JSON.parse(JSON.stringify(value));}
function blank(){return {name:'',currency:'sat',wallet:'',tip_wallet:'',fiat_wallet:'',provider:'',onchain_enabled:false,onchain_wallet_id:'',onchain_zero_conf:false,tax_inclusive:true,tax_default:0,allow_price_adjustment:true,tips_enabled:false,tip_options:[10,15,20],revenue_address:'',revenue_percent:0,business_name:'',business_address:'',business_vat_id:'',only_show_sats_on_bitcoin:true,enable_receipt_print:false,remote_enabled:false,products:[]};}
async function run(fn){if(busy.value)return;busy.value=true;error.value='';notice.value='';try{return await fn();}catch(e){error.value=e.message||'Something went wrong.';}finally{busy.value=false;}}
async function loadAdmin(){[terminals.value,meta.value]=await Promise.all([bridge.api('/terminals'),bridge.api('/metadata')]);}
async function edit(t){await run(async()=>{editor.value=t?{...blank(),...await bridge.api(`/terminals/${encodeURIComponent(t.id)}`)}:blank();});}
async function save(){await run(async()=>{await bridge.api('/terminals','POST',editor.value);editor.value=null;catalog.value=null;expanded.value=[];await loadAdmin();notice.value='PoS saved.';});}
async function disable(t){if(!await ask(`Disable ${t.name}? Its shared links will stop working.`))return;await run(async()=>{await bridge.api('/terminals/disable','POST',{id:t.id});await loadAdmin();});}
async function deleteTerminal(t){if(!await ask(`Delete ${t.name}? Its shared links will stop working. Existing payments and receipts remain in All sales.`))return;await run(async()=>{await bridge.api('/terminals/delete','POST',{id:t.id});catalog.value=null;expanded.value=[];share.value=null;await loadAdmin();notice.value='PoS deleted. Its receipts remain in All sales.';});}
async function rotate(t){if(!await ask('Replace both shared links? The old links will stop working.'))return;await run(async()=>{await bridge.api('/terminals/rotate','POST',{id:t.id});await loadAdmin();share.value=null;notice.value='Links replaced.';});}
function terminalUrl(token){return `${new URL(location.href).origin}/ext/pos/terminal/${encodeURIComponent(token)}`;}
async function shareTerminal(t){await run(async()=>{shareQr.value=await QRCode.toDataURL(terminalUrl(t.cashier_link),{width:260,margin:2});share.value={terminal:t,url:terminalUrl(t.cashier_link),display:terminalUrl(t.display_link)};});}
async function open(url){await run(()=>bridge.request('navigation.open_new_tab',{url}));}
async function background(t){await run(()=>bridge.request('permissions.request_background_payment',{forcePrompt:true,grant:{wallet_id:t.wallet}}));}
async function expand(t){await run(async()=>{if(expanded.value.includes(t.id)){expanded.value=[];catalog.value=null;return;}catalog.value=await bridge.api(`/terminals/${encodeURIComponent(t.id)}`);expanded.value=[t.id];});}
function editItem(p){error.value='';itemEditor.value=p?{...clone(p),categories:productCategories(p)}:{id:crypto.randomUUID().replaceAll('-',''),title:'',description:'',categories:[],price:'',tax:null,disabled:false,image:''};}
async function saveCatalog(products){
  const latest=await bridge.api(`/terminals/${encodeURIComponent(catalog.value.id)}`);
  catalog.value=await bridge.api('/terminals','POST',{...latest,products});await loadAdmin();
}
async function saveItem(){await run(async()=>{const rows=clone(catalog.value.products),i=rows.findIndex(p=>p.id===itemEditor.value.id);if(i<0)rows.push(clone(itemEditor.value));else rows[i]=clone(itemEditor.value);await saveCatalog(rows);itemEditor.value=null;});}
async function deleteItems(p){if(!await ask(p?`Delete ${p.title}?`:'Delete all items from this PoS?'))return;await run(()=>saveCatalog(p?catalog.value.products.filter(row=>row.id!==p.id):[]));}
async function importProducts(){await run(async()=>{
    const raw=JSON.parse(importText.value);if(!Array.isArray(raw)||raw.length>100)throw Error('Import a JSON array of up to 100 products.');
    const rows=raw.map(p=>{if(!p||typeof p!=='object'||Array.isArray(p))throw Error('Every imported item must be a product object.');return {id:crypto.randomUUID().replaceAll('-',''),title:p.title,description:p.description||'',price:String(p.price),tax:p.tax??null,categories:productCategories(p),disabled:p.disabled===true,image:p.image||''};});
    if(!await ask(importMode.value==='append'?`Add ${rows.length} imported items to this catalog?`:`Replace this catalog with ${rows.length} imported items?`))return;
    if(importMode.value==='append'){catalog.value=await bridge.api('/terminals','POST',{id:catalog.value.id,append_products:rows});await loadAdmin();}
    else await saveCatalog(rows);
    importText.value='';showImport.value=false;
});}
async function readProductFile(e){const file=e.target.files?.[0];if(!file)return;if(file.size>64000){error.value='Use a JSON file smaller than 64 KB.';return;}importText.value=await file.text();}
async function exportItems(){await run(()=>bridge.request('ui.download_csv',{filename:'pos-items.csv',columns:['ID','Title','Description','Price','Tax %','Categories','Disabled'],rows:catalog.value.products.map(p=>[p.id,p.title,p.description,p.price,p.tax??'',productCategories(p).join(', '),p.disabled])}));}
async function copy(value){await run(async()=>{try{await navigator.clipboard.writeText(value);notice.value='Copied to clipboard.';}catch{throw Error('Copy is unavailable. Select and copy the text below.');}});}
async function sharePublic(){await run(async()=>{shareQr.value=await QRCode.toDataURL(terminalUrl(link.value),{width:260,margin:2});share.value={terminal:terminal.value,url:terminalUrl(link.value)};});}
async function exportTerminals(){await run(()=>bridge.request('ui.download_csv',{filename:'pos-terminals.csv',columns:['Name','Currency','Active','Tax included'],rows:terminals.value.map(t=>[t.name,t.currency,t.active,t.tax_inclusive])}));}
async function showSales(t={id:'',name:'All sales'}){await run(async()=>{salesTerminal.value=t;offset.value=0;await loadSales();});}
async function loadSales(){sales.value=await bridge.api(`/sales?id=${encodeURIComponent(salesTerminal.value.id)}&offset=${offset.value}`);salesRates.value={};const page=sales.value;loadRates(page.rows).then(rates=>{if(sales.value===page)salesRates.value=rates;});}
async function loadRates(rows,publicHistory=false){
  const currencies=[...new Set(rows.filter(c=>c.status==='paid'&&['lightning','onchain'].includes(c.method)&&c.sale.currency!=='sat').map(c=>c.sale.currency))];
  const results=await Promise.all(currencies.map(async currency=>{try{const {rate}=await bridge.api(`${publicHistory?`/terminal/${link.value}/history-rate`:'/sales-rate'}?currency=${encodeURIComponent(currency)}`);return [currency,rate];}catch{return [currency,null];}}));
  return Object.fromEntries(results);
}
function valueNow(c,rates){const value=currentFiatValue(c,rates[c.sale.currency]);return value===null?'':money(value,c.sale.currency);}
async function printOwnerReceipt(c){await run(async()=>{const receipt=await bridge.api(`/sales/${encodeURIComponent(c.id)}`);await print(receipt);});}
async function pageSales(delta){await run(async()=>{offset.value=Math.max(0,offset.value+delta);await loadSales();});}
async function reconcile(c){await run(async()=>{const result=await bridge.api('/sales/reconcile','POST',{id:salesTerminal.value.id,checkout_id:c.id});await loadSales();if(result.onchain&&!result.onchain.status_available)error.value='Core has not synced this Bitcoin payment yet. Check again after sync.';});}
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
function quantity(p){return items.value.filter(l=>l.product_id===p.id).reduce((sum,l)=>sum+l.quantity,0);}
function subtract(p){if(cashierAttempt.value)return;const i=items.value.findLastIndex(l=>l.product_id===p.id);if(i<0)return;if(items.value[i].quantity>1)items.value[i].quantity--;else items.value.splice(i,1);}
function press(key){if(cashierAttempt.value)return;if(key==='⌫')keypad.value=keypad.value.slice(0,-1);else if(key==='C'){keypad.value='';items.value=items.value.filter(l=>l.product_id);tip.value='0';}else if(/^\d$/.test(key)){try{keypadAmount(keypad.value+key,currentCurrency.value);keypad.value+=key;}catch{error.value='Amount is too large.';}}}
function handleKeypad(event){
  if(loading.value||busy.value||!isPublic.value||terminal.value?.role!=='cashier'||view.value!=='keypad'||cashierAttempt.value||invoice.value||showTips.value||showMethods.value||showNote.value||lineEditor.value||share.value||showHistory.value||showHeld.value||confirmation.value||printPrompt.value||document.querySelector('.q-dialog,.q-menu'))return;
  if(event.key==='Escape'&&document.fullscreenElement)return;
  const key=keypadShortcut(event);if(!key)return;
  event.preventDefault();
  if(key==='Enter')startPayment();else if(key==='+')addCustom();else press(key);
}
function updateFullscreen(){fullscreen.value=!!document.fullscreenElement;}
async function toggleFullscreen(){await run(async()=>{
  try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}
  catch{throw Error('Fullscreen is unavailable in this browser.');}
});}
function addCustom(){try{if(cashierAttempt.value)return false;const amount=keypadValue.value;if(!minor(amount,currentCurrency.value))throw Error('Enter an amount.');items.value.push({title:'Custom amount',price:amount,quantity:1,note:''});keypad.value='';error.value='';return true;}catch(e){error.value=e.message;return false;}}
function switchView(){view.value=view.value==='products'?'keypad':'products';cartDrawer.value=view.value==='products'&&window.Quasar.Screen.gt.sm;}
function editLine(line,field){if(cashierAttempt.value)return;lineEditor.value={line,field,value:field==='price'?price(line):line.note};}
function saveLine(){try{const e=lineEditor.value;if(e.field==='price'&&!minor(e.value,currentCurrency.value))throw Error('Price must be positive.');e.line[e.field]=e.value;lineEditor.value=null;error.value='';}catch(e){error.value=e.message;}}
function startPayment(method=null){
  if(cashierAttempt.value){checkout(cashierAttempt.value.method);return;}
  if(keypad.value&&view.value==='keypad'&&!addCustom())return;
  if(!preview.value){error.value='Enter an amount or add items first.';return;}
  error.value='';pendingMethod.value=method;
  if(terminal.value.tips_enabled){showRound.value=false;showTips.value=true;}else chooseMethod();
}
function chooseMethod(){showTips.value=false;if(pendingMethod.value)checkout(pendingMethod.value);else if(terminal.value.fiat_enabled||terminal.value.onchain_enabled)showMethods.value=true;else checkout('lightning');}
function tipSelected(pct){setTip(pct);chooseMethod();}
function roundSelected(){error.value='';roundTotal();if(!error.value)chooseMethod();}
function pay(method){showMethods.value=false;checkout(method);}
function setTip(pct){if(!preview.value)return;const base=preview.value.total_minor-preview.value.tip_minor;tip.value=decimal(Math.round(base*pct/100),currentCurrency.value);}
function roundTotal(){try{if(!preview.value)return;const base=preview.value.total_minor-preview.value.tip_minor,target=minor(rounding.value,currentCurrency.value);if(target<base)throw Error('Round-up total must cover the sale.');tip.value=decimal(target-base,currentCurrency.value);}catch(e){error.value=e.message;}}
async function clearCart(){try{await session?.clear();items.value=[];keypad.value='';note.value='';tip.value='0';rounding.value='';cashierAttempt.value=null;invoice.value=null;invoiceQr.value='';qrSequence++;activeCheckoutId='';printPrompt.value=null;return true;}catch(e){error.value=e.message;return false;}}
async function checkout(method){await run(async()=>{
  if(!cashierAttempt.value)cashierAttempt.value={link:link.value,action_id:crypto.randomUUID().replaceAll('-',''),method,items:clone(items.value),tip:tip.value,note:note.value};
  await session.save(clone(cashierAttempt.value));
  const checkout=await bridge.api(`/terminal/${link.value}/checkout`,'POST',cashierAttempt.value);
  activeCheckoutId=checkout.id;
  await setInvoice(checkout);
});}
async function setInvoice(c){
  const previous=invoice.value?.payment_request;invoice.value=c;
  if(await completeCheckout(c,{role:terminal.value?.role,checkoutId:activeCheckoutId,history:receiptOnly.value},clearCart)){
    notice.value='Payment received. Ready for the next sale.';
    if(terminal.value.enable_receipt_print)printPrompt.value=c;
    return;
  }
  if(c?.payment_request && c.payment_request!==previous){const seq=++qrSequence;const png=await QRCode.toDataURL(c.payment_request,{width:360,margin:2});if(seq===qrSequence)invoiceQr.value=png;}
  if(!c?.payment_request){qrSequence++;invoiceQr.value='';}
}
async function poll(){
  if(polling||busy.value||!isPublic.value||!terminal.value)return;polling=true;
  try {
    if(terminal.value.role==='display')await loadTerminal();
    if(invoice.value?.id&&(terminal.value.role!=='display'||invoice.value.method==='onchain')){
      const id=invoice.value.id,receipt=receiptOnly.value;
      const result=await bridge.api(`/terminal/${link.value}/status?checkoutId=${encodeURIComponent(id)}`);
      if(invoice.value?.id===id&&receiptOnly.value===receipt)await setInvoice(result);
    }
    if(invoice.value?.onchain?.status_available)error.value='';
  }catch(e){if(invoice.value?.onchain){invoice.value.onchain.status_available=false;error.value='Core could not check this Bitcoin payment yet. Keep this checkout and retry after sync.';}else error.value=e.message;}finally{polling=false;}
}
async function closeCheckout(){
  if(receiptOnly.value){receiptOnly.value=false;await setInvoice(previousCheckout);previousCheckout=null;return;}
  if(invoice.value?.status==='paid'||invoice.value?.status==='failed'){await clearCart();return;}
  if(await ask('This checkout may still be paid. Start a separate sale? You can find this one in Receipts.'))await clearCart();
}
async function recent(){await run(async()=>{history.value=await bridge.api(`/terminal/${link.value}/history`);historyRates.value={};showHistory.value=true;const rows=history.value;loadRates(rows,true).then(rates=>{if(history.value===rows)historyRates.value=rates;});});}
async function viewReceipt(c){await run(async()=>{const receipt=c.method==='onchain'?(await bridge.api(`/terminal/${link.value}?checkoutId=${encodeURIComponent(c.id)}`)).latest:await bridge.api(`/terminal/${link.value}/status?checkoutId=${encodeURIComponent(c.id)}`);previousCheckout=invoice.value;receiptOnly.value=true;showHistory.value=false;await setInvoice(receipt);});}
function hold(){if(!items.value.length){error.value='Add something to the cart first.';return;}holdNote.value='';showHold.value=true;}
async function saveHeldCart(){await run(async()=>{
  if(!items.value.length)throw Error('Add something to the cart first.');
  if(cashierAttempt.value)throw Error('Finish the checkout before holding this cart.');
  held.value=await local.hold({items:clone(items.value),tip:tip.value,note:note.value},holdNote.value.trim()||new Date().toLocaleTimeString());showHold.value=false;await clearCart();notice.value='Cart held on this device.';
});}
async function heldCarts(){await run(async()=>{held.value=await local.list();showHeld.value=true;});}
async function resume(id){await run(async()=>{if(items.value.length&&!await ask('Replace the current cart?'))return;const c=await local.load(id);items.value=c.items;tip.value=c.tip||'0';note.value=c.note||'';await local.remove(id);showHeld.value=false;});}
async function removeHeld(id){await run(async()=>{await local.remove(id);held.value=await local.list();});}
async function print(c,order=false){
  const s=c.sale,b=c.business;
  const lines=[timestamp(c.created_at),c.terminal_name,`Payment: ${c.method} · ${c.status}`,b.name,b.address,b.vat_id?`VAT: ${b.vat_id}`:'',s.note].filter(Boolean);
  if(!order){const rate=receiptRate(c);if(rate)lines.push(rate);lines.push(`Subtotal: ${money(s.subtotal_minor,s.currency)}`,`Tax${s.tax_inclusive?' (included)':''}: ${money(s.tax_minor,s.currency)}`,`Tip: ${money(s.tip_minor,s.currency)}`,`Total: ${money(s.total_minor,s.currency)}`);if(c.method==='lightning'||c.method==='onchain'||!b.only_show_sats_on_bitcoin)lines.push(`Bitcoin amount: ${c.amount_sat} sats`);if(c.onchain)lines.push(`Network: ${c.onchain.network}`,`Address: ${c.onchain.address}`);}
  await bridge.request('ui.print_document',{title:order?'Order':'Receipt',lines,columns:order?['Item','Quantity','Note']:['Item','Quantity','Unit price','Note'],rows:s.items.map(l=>order?[l.title,l.quantity,l.note]:[l.title,l.quantity,money(l.price_minor,s.currency),l.note])});
}
onMounted(async()=>{
  document.addEventListener('keydown',handleKeypad);
  document.addEventListener('fullscreenchange',updateFullscreen);
  fullscreenAvailable.value=document.fullscreenEnabled===true;updateFullscreen();
  try {
    const context=await bridge.request('context');isPublic.value=context.public;applyCoreTheme(context.theme);link.value=context.routeParams?.link||'';
    unsubscribe=bridge.onEvent(e=>{if(e.event==='ui.theme')applyCoreTheme(e.data);if(e.event==='websocket.message')poll();});
    if(isPublic.value){
      if(!/^[A-Za-z0-9_-]{8,128}$/.test(link.value))throw Error('Invalid terminal link.');
      await loadTerminal();
      const savedAppearance=await appearance.load();mono.value=savedAppearance.mono;tileSize.value=savedAppearance.tileSize;appearanceReady=true;
      view.value=terminal.value.products?.some(p=>!p.disabled)?'products':'keypad';cartDrawer.value=view.value==='products'&&window.Quasar.Screen.gt.sm;
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
onBeforeUnmount(()=>{document.removeEventListener('keydown',handleKeypad);document.removeEventListener('fullscreenchange',updateFullscreen);clearInterval(timer);unsubscribe?.();bridge.close().catch(()=>{});});
</script>

<template>
<q-layout container view="hHh Lpr fFf" class="pos-layout">
  <q-header v-if="isPublic" class="bg-primary text-white">
    <q-toolbar>
      <img src="/ext-assets/pos/assets/icon.png" width="32" height="32" alt="PoS logo" class="q-mr-sm">
      <q-toolbar-title>{{terminal?.name||'PoS'}}</q-toolbar-title>
      <template v-if="terminal?.role==='cashier'">
        <q-btn-toggle v-model="mono" dense no-caps toggle-color="secondary" :options="[{label:'Color',value:false},{label:'Mono',value:true}]" aria-label="Keypad colors" />
        <q-btn flat round icon="add_comment" @click="showNote=true" :disable="!!cashierAttempt" aria-label="Add note"><q-tooltip>Add note</q-tooltip></q-btn>
      </template>
    </q-toolbar>
  </q-header>

  <q-drawer v-if="isPublic&&terminal?.role==='cashier'&&view==='products'" v-model="cartDrawer" side="right" bordered :breakpoint="1024" :width="$q.screen.lt.sm?Math.min($q.screen.width,360):450">
    <div class="column no-wrap full-height">
      <div class="row items-center q-pa-md">
        <div class="text-h4 col text-center">{{money(preview?.total_minor||0)}}</div>
        <q-btn flat round dense icon="close" aria-label="Hide cart" @click="cartDrawer=false" />
      </div>
      <q-separator />
      <div class="col scroll q-pa-sm">
        <p v-if="!items.length" class="text-center q-pa-lg">Cart is empty</p>
        <div v-for="(line,i) in items" :key="i" class="row items-center no-wrap q-py-sm q-gutter-xs">
          <q-btn flat no-caps align="left" class="col cart-item-name" @click="editLine(line,'note')" :disable="!!cashierAttempt"><span>{{title(line)}}<small v-if="line.note" class="block">{{line.note}}</small></span><q-tooltip>Add item note</q-tooltip></q-btn>
          <q-btn flat dense round icon="remove" size="sm" :disable="!!cashierAttempt||line.quantity<=1" @click="line.quantity--" :aria-label="'Decrease '+title(line)" />
          <span>{{line.quantity}}</span>
          <q-btn flat dense round icon="add" size="sm" :disable="!!cashierAttempt||line.quantity>=999" @click="line.quantity++" :aria-label="'Increase '+title(line)" />
          <q-btn flat dense no-caps :label="price(line)" @click="editLine(line,'price')" :disable="!!cashierAttempt||!!line.product_id&&!terminal.allow_price_adjustment"><q-tooltip>Unit price</q-tooltip></q-btn>
          <q-btn flat round dense color="negative" icon="delete" size="sm" @click="items.splice(i,1)" :disable="!!cashierAttempt" :aria-label="'Remove '+title(line)" />
        </div>
      </div>
      <q-separator />
      <div class="q-pa-md q-gutter-y-sm">
        <div class="row justify-between"><span>Subtotal</span><span>{{money(preview?.subtotal_minor||0)}}</span></div>
        <div class="row justify-between"><span>Tax {{terminal.tax_inclusive?'(incl.)':''}}</span><span>{{money(preview?.tax_minor||0)}}</span></div>
        <div v-if="preview?.tip_minor" class="row justify-between"><span>Tip</span><span>{{money(preview.tip_minor)}}</span></div>
        <q-btn v-if="items.some(l=>!l.product_id)" flat dense no-caps label="Manual input" @click="switchView" :disable="!!cashierAttempt" />
        <div class="row justify-between text-h6"><span>Total</span><span>{{money(preview?.total_minor||0)}}</span></div>
        <div class="row q-col-gutter-sm">
          <div class="col"><q-btn rounded unelevated color="primary" icon="bolt" :label="cashierAttempt?'Check / retry':'Lightning'" class="full-width payment-button" @click="startPayment('lightning')" :disable="busy||!preview" /></div>
          <div v-if="terminal.onchain_enabled&&!cashierAttempt" class="col"><q-btn rounded unelevated color="primary" icon="currency_bitcoin" label="On-chain" class="full-width payment-button" @click="startPayment('onchain')" :disable="busy||!preview" /></div>
          <div v-if="terminal.fiat_enabled&&!cashierAttempt" class="col"><q-btn rounded unelevated color="secondary" icon="qr_code" :label="currentCurrency" class="full-width payment-button" @click="startPayment('fiat')" :disable="busy||!preview" /></div>
        </div>
        <q-btn color="negative" outline class="full-width" label="Clear cart" @click="clearCart" :disable="busy||!!cashierAttempt||!items.length" />
      </div>
    </div>
  </q-drawer>

  <q-page-container>
    <q-page class="q-pa-md">
      <q-banner v-if="error" role="alert" class="bg-negative text-white q-mb-md" inline-actions>{{error}}<template #action><q-btn flat round icon="close" @click="error=''" aria-label="Dismiss error" /></template></q-banner>
      <q-banner v-if="notice" role="status" class="q-mb-md" inline-actions>{{notice}}<template #action><q-btn flat round icon="close" @click="notice=''" aria-label="Dismiss message" /></template></q-banner>
      <div v-if="loading" class="text-center q-pa-xl"><q-spinner color="primary" size="md" /><p>Connecting to LNbits…</p></div>

      <section v-else-if="!isPublic" class="row q-col-gutter-md">
        <div class="col-12 col-md-8 col-lg-7 q-gutter-y-md">
          <q-card><q-card-section class="row q-gutter-sm"><q-btn unelevated color="primary" label="New PoS" @click="edit()" :disable="busy" /><q-btn flat color="primary" label="All sales" @click="showSales()" :disable="busy" /></q-card-section></q-card>
          <q-card>
            <q-card-section class="row items-center justify-between"><span class="text-h6">PoS</span><q-btn flat color="grey" label="Export to CSV" @click="exportTerminals" :disable="busy||!terminals.length" /></q-card-section>
            <q-card-section class="q-pt-none">
              <q-table dense flat :rows="terminals" :columns="terminalColumns" row-key="id" :pagination="{rowsPerPage:10}" no-data-label="No PoS yet. Click New PoS to get started.">
                <template #body="props">
                  <q-tr :props="props">
                    <q-td key="actions" :props="props" auto-width>
                      <q-btn round dense size="sm" color="accent" :icon="expanded.includes(props.row.id)?'expand_less':'expand_more'" @click="expand(props.row)" :disable="busy" :aria-label="'Items for '+props.row.name" />
                      <q-btn square dense size="sm" color="grey" icon="qr_code" class="q-ml-sm" @click="shareTerminal(props.row)" :disable="busy||!props.row.active" aria-label="PoS QR"><q-tooltip>PoS QR</q-tooltip></q-btn>
                      <q-btn square dense size="sm" color="grey" icon="launch" class="q-ml-xs" @click="open(terminalUrl(props.row.cashier_link))" :disable="busy||!props.row.active" aria-label="Open PoS"><q-tooltip>Open PoS</q-tooltip></q-btn>
                      <q-btn flat dense size="xs" color="blue" icon="edit" class="q-ml-sm" @click="edit(props.row)" :disable="busy" aria-label="Edit PoS"><q-tooltip>Edit PoS</q-tooltip></q-btn>
                      <q-btn flat dense size="xs" color="pink" icon="cancel" @click="disable(props.row)" :disable="busy||!props.row.active" aria-label="Disable PoS"><q-tooltip>Disable PoS</q-tooltip></q-btn>
                      <q-btn flat dense size="xs" icon="more_vert" aria-label="More actions" :disable="busy"><q-menu><q-list dense>
                        <q-item clickable v-close-popup @click="showSales(props.row)"><q-item-section>Sales &amp; receipts</q-item-section></q-item>
                        <q-item v-if="props.row.tip_wallet||props.row.revenue_address" clickable v-close-popup @click="background(props.row)"><q-item-section>Payment permission</q-item-section></q-item>
                        <q-item clickable v-close-popup @click="rotate(props.row)"><q-item-section>Replace links</q-item-section></q-item>
                        <q-item clickable v-close-popup @click="deleteTerminal(props.row)"><q-item-section class="text-negative">Delete PoS</q-item-section></q-item>
                      </q-list></q-menu></q-btn>
                    </q-td>
                    <q-td key="name" :props="props">{{props.row.name}} <q-badge v-if="!props.row.active" color="grey" label="Disabled" /></q-td>
                    <q-td key="currency" :props="props">{{props.row.currency}}</q-td>
                    <q-td key="provider" :props="props">{{props.row.provider}}</q-td>
                    <q-td key="revenue_address" :props="props">{{props.row.revenue_address}}</q-td>
                    <q-td key="revenue_percent" :props="props">{{props.row.revenue_percent||''}}</q-td>
                  </q-tr>
                  <q-tr v-if="expanded.includes(props.row.id)&&catalog?.id===props.row.id" :props="props">
                    <q-td colspan="100%" class="q-pa-md">
                      <q-tabs model-value="items" no-caps class="bg-dark text-white shadow-2"><q-tab name="items" label="Items" /></q-tabs>
                      <div class="row items-center q-gutter-sm q-my-md">
                        <q-btn unelevated color="primary" label="Add Item" @click="editItem()" :disable="busy||catalog.products.length>=100" />
                        <q-btn outline color="grey" label="Delete All" @click="deleteItems()" :disable="busy||!catalog.products.length" />
                        <q-space /><q-btn-dropdown outline color="primary" label="Import/Export" :disable="busy"><q-list>
                          <q-item clickable v-close-popup @click="showImport=true;error=''"><q-item-section>Import JSON</q-item-section></q-item>
                          <q-item clickable v-close-popup @click="exportItems"><q-item-section>Export to CSV</q-item-section></q-item>
                        </q-list></q-btn-dropdown>
                      </div>
                      <q-markup-table dense flat>
                        <thead><tr><th></th><th class="text-left">ID</th><th class="text-left">Title</th><th class="text-right">Price</th><th class="text-right">Tax %</th><th>Disabled</th></tr></thead>
                        <tbody><tr v-for="(p,i) in catalog.products" :key="p.id"><td><q-btn flat dense size="xs" icon="cancel" color="pink" @click="deleteItems(p)" :disable="busy" :aria-label="'Delete '+p.title" /><q-btn flat dense size="xs" icon="edit" color="accent" @click="editItem(p)" :disable="busy" :aria-label="'Edit '+p.title" /></td><td>{{i+1}}</td><td>{{p.title}}</td><td class="text-right">{{p.price}}</td><td class="text-right">{{p.tax??catalog.tax_default}}</td><td class="text-center"><q-icon v-if="p.disabled" name="check" /></td></tr><tr v-if="!catalog.products.length"><td colspan="6" class="text-center">No items</td></tr></tbody>
                      </q-markup-table>
                    </q-td>
                  </q-tr>
                </template>
              </q-table>
            </q-card-section>
          </q-card>
        </div>
        <aside class="col-12 col-md-4 col-lg-5"><q-card>
          <q-card-section class="row items-center q-gutter-sm"><img src="/ext-assets/pos/assets/icon.png" width="40" height="40" alt="PoS logo"><span class="text-h6">LNbits PoS extension</span></q-card-section>
          <q-expansion-item label="About PoS" icon="info"><q-card-section>Make a point of sale linked to your wallet. Share its PoS link with staff to accept payments, while keeping your wallet settings private.</q-card-section></q-expansion-item>
        </q-card></aside>
      </section>

      <section v-else-if="terminal?.role==='cashier'" class="cashier-page">
        <div class="row items-start no-wrap q-gutter-sm q-mb-md">
          <template v-if="view==='products'">
            <q-btn flat round :icon="listView?'grid_view':'view_list'" @click="listView=!listView" :aria-label="listView?'Grid view':'List view'" />
            <q-slider v-if="!listView" v-model="tileSize" :min="80" :max="240" :step="40" class="tile-size gt-xs" aria-label="Item size" />
            <q-input dense filled v-model="search" label="Filter" clearable @clear="search=''" class="catalog-filter"><template #append><q-icon name="search" /></template></q-input>
          </template>
          <q-space />
          <q-fab color="primary" icon="keyboard_arrow_down" active-icon="close" direction="down" padding="sm" aria-label="PoS options">
            <q-fab-action color="primary" icon="receipt" label="Receipts" @click="recent" :disable="busy" />
            <q-fab-action v-if="fullscreenAvailable" color="primary" :icon="fullscreen?'fullscreen_exit':'fullscreen'" :label="fullscreen?'Exit fullscreen':'Fullscreen'" @click="toggleFullscreen" :disable="busy" />
            <q-fab-action color="primary" :icon="view==='products'?'dialpad':'point_of_sale'" :label="view==='products'?'PoS View':'Cart View'" @click="switchView" />
            <q-fab-action color="primary" icon="pause_circle_outline" label="Carts on hold" @click="heldCarts" :disable="busy||!!cashierAttempt" />
            <q-fab-action color="primary" icon="qr_code" label="Share URL" @click="sharePublic" :disable="busy" />
          </q-fab>
        </div>
        <template v-if="view==='products'">
          <div v-if="categories.length" class="row q-gutter-xs q-mb-md"><q-btn v-for="c in categories" :key="c" no-caps :outline="category!==c" color="primary" :label="c" @click="category=category===c?'':c" /></div>
          <q-list v-if="listView" separator>
            <q-item v-for="p in products" :key="p.id" clickable @click="add(p)" :disable="!!cashierAttempt">
              <q-item-section avatar><q-avatar rounded><img v-if="p.image" :src="p.image" alt=""><q-icon v-else name="sell" /></q-avatar></q-item-section>
              <q-item-section><q-item-label>{{p.title}}</q-item-label><q-item-label caption>{{p.price}} {{currentCurrency==='sat'?'sats':currentCurrency}} <span v-if="p.description">· {{p.description}}</span></q-item-label></q-item-section>
              <q-item-section side><div class="row items-center q-gutter-sm"><q-btn flat dense round icon="remove" @click.stop="subtract(p)" :disable="!!cashierAttempt||!quantity(p)" :aria-label="'Remove '+p.title" /><span>{{quantity(p)}}</span><q-btn flat dense round icon="add" @click.stop="add(p)" :disable="!!cashierAttempt" :aria-label="'Add '+p.title" /></div></q-item-section>
            </q-item>
          </q-list>
          <div v-else class="product-grid" :class="'tiles-'+tileSize">
            <q-btn v-for="p in products" :key="p.id" flat no-caps class="q-pa-none product-tile" @click="add(p)" :disable="!!cashierAttempt" :aria-label="'Add '+p.title">
              <q-card flat bordered class="full-width">
                <div class="product-image relative-position flex flex-center"><img v-if="p.image" :src="p.image" alt=""><q-icon v-else name="sell" size="xl" color="grey" /><div class="absolute-bottom bg-dark text-white text-center q-pa-xs product-title">{{p.title}}</div></div>
                <q-separator color="primary" />
                <div class="q-pa-xs text-center">{{p.price}} {{currentCurrency==='sat'?'sats':currentCurrency}}</div>
                <q-badge v-if="quantity(p)" floating color="primary" :label="quantity(p)" />
              </q-card>
            </q-btn>
          </div>
          <div v-if="!products.length" class="text-center q-pa-xl"><p>{{search||category?'No matching items':'No items yet'}}</p><q-btn flat color="primary" label="PoS View" @click="switchView" /></div>
          <q-page-sticky v-if="items.length" position="bottom" :offset="[0,18]" class="cart-toolbar"><div class="row q-gutter-sm"><q-btn rounded unelevated color="secondary" icon="pause" label="Hold Cart" @click="hold" :disable="busy||!!cashierAttempt" /><q-btn rounded unelevated color="primary" icon="shopping_cart" label="Checkout" @click="cartDrawer=true" /></div></q-page-sticky>
        </template>
        <div v-else class="keypad">
          <div class="text-center q-py-lg"><div class="text-h3">{{keypadValue}} <span class="text-h5">{{currentCurrency==='sat'?'sats':currentCurrency}}</span></div>
            <div v-if="preview" class="text-subtitle1 text-italic q-mt-sm">+ {{money(preview.total_minor)}} <q-btn flat round dense icon="cancel" size="sm" aria-label="Clear added amounts" @click="clearCart" :disable="!!cashierAttempt" /></div>
          </div>
          <q-page-sticky expand position="bottom"><div class="row justify-center full-width"><div class="col-12 col-sm-8 col-md-6 col-lg-4 keypad-grid q-pa-sm">
            <q-btn v-for="key in ['1','2','3','4','5','6','7','8','9','C','0','⌫']" :key="key" unelevated rounded :outline="!$q.dark.isActive" size="xl" :color="key==='C'?(mono?'secondary':'negative'):key==='⌫'?(mono?'secondary':'warning'):'primary'" :label="key==='⌫'?undefined:key" :icon="key==='⌫'?'backspace':undefined" :aria-label="key==='⌫'?'Backspace':key==='C'?'Clear amount':key" @click="press(key)" :disable="busy||!!cashierAttempt" />
            <q-btn unelevated rounded :outline="!$q.dark.isActive" size="xl" color="primary" icon="add" class="keypad-plus" @click="addCustom" :disable="busy||!!cashierAttempt" aria-label="Add amount" />
            <q-btn unelevated rounded :outline="!$q.dark.isActive" size="xl" :color="mono?'secondary':'positive'" :label="cashierAttempt?'Retry':'Ok'" class="keypad-ok" @click="startPayment()" :disable="busy" />
          </div></div></q-page-sticky>
        </div>
      </section>
      <section v-else-if="terminal?.role==='display'&&!invoice" class="text-center q-pa-xl"><q-icon name="point_of_sale" color="primary" size="xl" /><h1 class="text-h4">Welcome to {{terminal.name}}</h1><p>Your checkout will appear here.</p></section>
    </q-page>
  </q-page-container>

  <q-dialog :model-value="!!editor" position="top" persistent>
    <q-card v-if="editor" class="settings-dialog column no-wrap">
      <q-card-section class="row items-center justify-between"><h2 class="text-h6 q-ma-none">{{editor.id?'Edit PoS':'Create PoS'}}</h2><q-btn flat round dense icon="close" @click="editor=null" aria-label="Close" :disable="busy" /></q-card-section>
      <q-card-section class="col scroll q-gutter-y-md">
        <q-input filled dense v-model="editor.name" maxlength="80" label="Name *" />
        <q-select filled dense v-model="editor.wallet" :options="lightningWallets" option-label="name" option-value="id" emit-value map-options label="Wallet *" />
        <q-select filled dense v-model="editor.currency" :options="meta.currencies" label="Currency *" />
        <q-list bordered separator class="rounded-borders">
          <q-expansion-item icon="payments" label="Payment methods" caption="Lightning and hosted card payments"><div class="q-pa-md q-gutter-y-md">
            <q-select filled dense v-model="editor.provider" :options="[{label:'Disabled',value:''},...meta.providers.map(p=>({label:p,value:p}))]" emit-value map-options label="Fiat provider" :disable="editor.currency==='sat'" />
            <q-select v-if="editor.provider" filled dense v-model="editor.fiat_wallet" :options="meta.wallets.filter(w=>w.wallet_type==='fiat'&&w.currency?.toUpperCase()===editor.currency)" option-label="name" option-value="id" emit-value map-options label="Fiat Wallet" />
          </div></q-expansion-item>
          <q-expansion-item icon="currency_bitcoin" label="On-chain payments" :caption="editor.onchain_enabled?'Enabled':'Disabled'"><div class="q-pa-md q-gutter-y-md">
            <q-checkbox v-model="editor.onchain_enabled" label="Enable on-chain payments" />
            <template v-if="editor.onchain_enabled">
              <q-select filled dense v-model="editor.onchain_wallet_id" :options="onchainWallets" option-label="label" option-value="id" emit-value map-options label="On-chain wallet *" hint="A fresh receive address is reserved for each checkout." />
              <p v-if="!onchainWallets.length" class="text-caption">Create an on-chain wallet in LNbits first.</p>
              <q-toggle v-model="editor.onchain_zero_conf" label="Accept on-chain payment at 0-conf"><q-tooltip>When disabled, wait for the first confirmation.</q-tooltip></q-toggle>
              <p class="text-caption">On-chain tips stay in this wallet. Revenue sharing applies to Lightning sales only.</p>
            </template>
          </div></q-expansion-item>
          <q-expansion-item icon="volunteer_activism" label="Tips" :caption="editor.tips_enabled?'Enabled':'Disabled'"><div class="q-pa-md q-gutter-y-md">
            <q-checkbox v-model="editor.tips_enabled" label="Enable tips" />
            <template v-if="editor.tips_enabled"><q-select filled dense v-model="editor.tip_wallet" :options="[{id:'',name:'Keep tips in receiving wallet'},...lightningWallets]" option-label="name" option-value="id" emit-value map-options label="Tip Wallet" />
              <q-select filled dense multiple use-input use-chips hide-dropdown-icon v-model="editor.tip_options" new-value-mode="add-unique" inputmode="numeric" label="Tip % Options (hit enter to add values)" />
              <p class="text-caption">Separate Lightning tips require payment permission. Fiat tips stay in the fiat wallet.</p>
            </template>
          </div></q-expansion-item>
          <q-expansion-item icon="point_of_sale" label="Checkout" caption="Price adjustments and remote payments"><div class="q-pa-md q-gutter-y-md">
            <q-checkbox v-model="editor.allow_price_adjustment" label="Allow cart item price adjustment" />
            <q-checkbox v-model="editor.remote_enabled" label="Enable remote (to trigger payments on external device)" />
          </div></q-expansion-item>
          <q-expansion-item icon="receipt_long" label="Receipts" caption="Business details for printing"><div class="q-pa-md q-gutter-y-md">
            <q-checkbox v-model="editor.enable_receipt_print" label="Prompt to print after payment" />
            <q-input filled dense v-model="editor.business_name" maxlength="120" label="Business name" placeholder="My Shop" />
            <q-input filled dense v-model="editor.business_address" maxlength="300" rows="3" type="textarea" label="Business address" />
            <q-input filled dense v-model="editor.business_vat_id" maxlength="80" label="VAT ID" />
            <q-checkbox v-model="editor.only_show_sats_on_bitcoin" label="Only show sats on bitcoin transactions" />
          </div></q-expansion-item>
          <q-expansion-item icon="inventory" label="Tax settings" caption="Prices and default tax rate"><div class="q-pa-md q-gutter-y-md">
            <p class="text-caption">Tax Inclusive means the unit price includes tax. Tax Exclusive means tax is added to the unit price.</p>
            <q-toggle v-model="editor.tax_inclusive" :label="editor.tax_inclusive?'Tax Inclusive':'Tax Exclusive'" />
            <q-input filled dense v-model="editor.tax_default" type="number" min="0" max="100" step="0.01" label="Default tax rate %" />
          </div></q-expansion-item>
          <q-expansion-item icon="share" label="Revenue sharing" caption="Share Lightning sales"><div class="q-pa-md q-gutter-y-md">
            <q-input filled dense v-model="editor.revenue_address" label="Lightning address" placeholder="name@example.com" maxlength="254" />
            <q-input filled dense v-model="editor.revenue_percent" type="number" min="0" max="100" step="0.01" label="LNaddress Cut (%)" />
            <p class="text-caption">Share a percentage of Lightning sales, excluding tips. Requires payment permission.</p>
          </div></q-expansion-item>
        </q-list>
        <p v-if="error" class="text-negative" role="alert">{{error}}</p>
      </q-card-section>
      <q-card-actions><q-btn color="primary" :label="editor.id?'Update PoS':'Create PoS'" @click="save" :loading="busy" /><q-space /><q-btn flat color="grey" label="Cancel" @click="editor=null" :disable="busy" /></q-card-actions>
    </q-card>
  </q-dialog>

  <q-dialog :model-value="!!itemEditor" position="top" persistent>
    <q-card v-if="itemEditor" class="item-dialog q-pa-lg q-pt-xl">
      <div class="q-gutter-y-md">
        <q-input filled dense v-model="itemEditor.title" maxlength="80" label="Title *" />
        <q-input filled dense v-model="itemEditor.description" maxlength="240" label="Description" />
        <q-input filled dense v-model="itemEditor.image" maxlength="8192" label="Image data" hint="Small PNG, JPEG or WebP data image. Remote URLs are not supported." />
        <q-input filled dense v-model="itemEditor.price" inputmode="decimal" :label="'Price ('+catalog.currency+') *'" />
        <q-select filled dense v-model="itemEditor.categories" :options="catalogCategories" multiple use-chips use-input new-value-mode="add-unique" :max-values="10" maxlength="40" label="Categories (hit enter to add values)" />
        <q-input filled dense v-model="itemEditor.tax" type="number" min="0" max="100" step="0.01" label="Tax %" :hint="'Leave empty for default. Tax '+(catalog.tax_inclusive?'included in':'added to')+' price.'" />
        <q-checkbox v-model="itemEditor.disabled" label="Disable" />
        <p v-if="error" class="text-negative" role="alert">{{error}}</p>
      </div>
      <q-card-actions class="q-px-none q-pt-lg"><q-btn color="primary" :label="catalog.products.some(p=>p.id===itemEditor.id)?'Update Item':'Create Item'" @click="saveItem" :loading="busy" /><q-space /><q-btn flat color="grey" label="Cancel" @click="itemEditor=null" :disable="busy" /></q-card-actions>
    </q-card>
  </q-dialog>

  <q-dialog v-model="showImport" position="top" :persistent="busy"><q-card class="lnbits__dialog-card q-pa-lg">
    <h2 class="text-h6 q-mt-none">Import Items</h2><p>Import a TPoS JSON item list. Add to your catalog or replace all items.</p>
    <p class="text-caption">Up to 100 items and 10 categories per item. Only small data images are supported. Remove remote image URLs before importing.</p>
    <label class="block q-mb-md">JSON file <input type="file" accept="application/json,.json" @change="readProductFile"></label>
    <q-input filled v-model="importText" type="textarea" rows="5" label="Items JSON" />
    <q-option-group v-model="importMode" :options="[{label:'Add to existing items',value:'append'},{label:'Replace all items',value:'replace'}]" color="primary" />
    <p v-if="error" class="text-negative" role="alert">{{error}}</p>
    <q-card-actions class="q-px-none"><q-btn color="primary" label="Import" @click="importProducts" :loading="busy" /><q-space /><q-btn flat color="grey" label="Cancel" v-close-popup :disable="busy" /></q-card-actions>
  </q-card></q-dialog>

  <q-dialog v-model="showNote" position="top"><q-card class="lnbits__dialog-card q-pa-lg"><h2 class="text-h6 q-mt-none">Add note</h2><q-input filled v-model="note" maxlength="240" label="Note" :disable="!!cashierAttempt" /><q-card-actions align="right"><q-btn flat color="primary" label="Ok" v-close-popup /></q-card-actions></q-card></q-dialog>
  <q-dialog v-model="showHold" position="top" :persistent="busy"><q-card class="lnbits__dialog-card q-pa-lg"><h2 class="text-h6 q-mt-none">Hold cart</h2><q-input filled v-model="holdNote" maxlength="36" label="Note (optional)" :disable="busy" @keyup.enter="saveHeldCart" /><p v-if="error" role="alert" class="text-negative">{{error}}</p><q-card-actions align="right"><q-btn flat color="grey" label="Cancel" v-close-popup :disable="busy" /><q-btn color="primary" label="Hold" @click="saveHeldCart" :loading="busy" /></q-card-actions></q-card></q-dialog>
  <q-dialog :model-value="!!lineEditor" position="top" @update:model-value="lineEditor=null"><q-card v-if="lineEditor" class="lnbits__dialog-card q-pa-lg"><h2 class="text-h6 q-mt-none">{{title(lineEditor.line)}}</h2><q-input filled v-model="lineEditor.value" :inputmode="lineEditor.field==='price'?'decimal':'text'" :maxlength="lineEditor.field==='note'?160:16" :label="lineEditor.field==='price'?'Unit price ('+currentCurrency+')':'Item note'" /><p v-if="error" role="alert" class="text-negative">{{error}}</p><q-card-actions><q-btn color="primary" label="Ok" @click="saveLine" /><q-space /><q-btn flat color="grey" label="Cancel" @click="lineEditor=null" /></q-card-actions></q-card></q-dialog>
  <q-dialog v-model="showTips" position="top"><q-card class="lnbits__dialog-card q-pa-lg q-pt-xl">
    <div class="text-h5 text-center q-mb-xl">Would you like to leave a tip?</div>
    <div class="row justify-center q-gutter-sm q-mb-lg"><q-btn v-for="p in terminal.tip_options" :key="p" unelevated rounded :outline="!$q.dark.isActive" size="lg" color="primary" :label="p+'%'" @click="tipSelected(p)" /><q-btn unelevated rounded :outline="!$q.dark.isActive" size="lg" color="primary" label="Round to" @click="showRound=true" /></div>
    <div v-if="showRound" class="row q-gutter-sm q-mb-lg"><q-input class="col" v-model="rounding" inputmode="decimal" :prefix="currentCurrency" label="Total amount including tip" /><q-btn color="primary" label="Ok" @click="roundSelected" /></div>
    <p v-if="error" class="text-negative" role="alert">{{error}}</p>
    <q-card-actions><q-btn flat color="primary" label="No, thanks" @click="tipSelected(0)" /><q-space /><q-btn flat color="grey" label="Close" v-close-popup /></q-card-actions>
  </q-card></q-dialog>
  <q-dialog v-model="showMethods" position="top"><q-card class="lnbits__dialog-card q-pa-lg"><div class="row q-col-gutter-md"><div class="col"><q-btn rounded unelevated color="primary" icon="bolt" label="Lightning" class="full-width payment-button" @click="pay('lightning')" /></div><div v-if="terminal.onchain_enabled" class="col"><q-btn rounded unelevated color="primary" icon="currency_bitcoin" label="On-chain" class="full-width payment-button" @click="pay('onchain')" /></div><div v-if="terminal.fiat_enabled" class="col"><q-btn rounded unelevated color="secondary" icon="qr_code" :label="currentCurrency" class="full-width payment-button" @click="pay('fiat')" /></div></div><q-card-actions align="right"><q-btn flat color="grey" label="Close" v-close-popup /></q-card-actions></q-card></q-dialog>

  <q-dialog :model-value="!!share" position="top" @update:model-value="share=null">
    <q-card v-if="share" class="lnbits__dialog-card">
      <q-card-section class="row items-center justify-between"><h2 class="text-h6 q-ma-none">Share {{share.terminal.name}}</h2><q-btn flat round dense icon="close" @click="share=null" aria-label="Close" /></q-card-section>
      <q-card-section>
        <img class="qr small-qr q-mb-md" :src="shareQr" alt="Cashier link QR code">
        <q-input filled readonly :model-value="share.url" label="PoS URL" @focus="$event.target.select()" />
        <p class="text-caption q-mt-sm">Anyone with this link can create checkouts and view this terminal’s recent receipts. Share it with staff.</p>
        <template v-if="share.display&&share.terminal.remote_enabled"><q-input filled readonly :model-value="share.display" label="Customer display link" @focus="$event.target.select()" /><q-btn flat color="primary" icon-right="open_in_new" label="Open customer display" class="q-mt-sm" @click="open(share.display)" /></template>
      </q-card-section>
      <q-card-actions><q-btn outline color="grey" label="Copy URL" @click="copy(share.url)" :disable="busy" /><q-space /><q-btn flat color="grey" label="Close" @click="share=null" /></q-card-actions>
    </q-card>
  </q-dialog>

  <q-dialog :model-value="!!invoice" position="top" persistent>
    <q-card v-if="invoice" class="lnbits__dialog-card">
      <q-card-section class="row items-center justify-between">
        <h2 class="text-h6 q-ma-none">{{invoice.status==='paid'?'Payment received':invoice.status==='failed'?'Payment expired or failed':'Payment'}}</h2>
        <q-btn v-if="terminal?.role!=='display'" flat round dense icon="close" @click="closeCheckout" aria-label="Close checkout" />
      </q-card-section>
      <q-card-section class="text-center">
        <p v-if="error" class="text-negative" role="alert">{{error}}</p>
        <div v-if="invoice.status==='paid'" class="q-mb-md"><q-icon name="check_circle" color="positive" size="xl" /></div>
        <q-badge v-if="invoice.onchain" color="primary" class="q-mb-md">Bitcoin · {{invoice.onchain.network}}</q-badge>
        <img v-if="invoice.status==='pending'&&invoiceQr" class="qr q-mb-md" :src="invoiceQr" :alt="invoice.method==='onchain'?'Bitcoin payment QR code':invoice.method==='lightning'?'Lightning invoice QR code':'Card checkout QR code'">
        <div class="text-h4 q-my-md">{{money(invoice.sale.total_minor,invoice.sale.currency)}}</div>
        <p v-if="(invoice.method==='lightning'||invoice.method==='onchain')&&invoice.sale.currency!=='sat'">{{invoice.amount_sat.toLocaleString()}} sats</p>
        <template v-if="invoice.onchain">
          <q-input filled dense readonly :model-value="invoice.onchain.address" label="Bitcoin address" @focus="$event.target.select()" />
          <p v-if="invoice.onchain.status_available" class="q-mt-md">Received: {{invoice.onchain.received_sat}} sats · Confirmed: {{invoice.onchain.confirmed_sat}} sats</p>
          <p v-else class="q-mt-md" role="status">Payment status is unavailable while core syncs. Keep this checkout and check again.</p>
          <p v-if="invoice.status==='pending'">{{invoice.onchain.zero_conf?'Unconfirmed payments are accepted.':'Waiting for the full amount and one confirmation.'}}</p>
        </template>
        <template v-if="invoice.status==='pending'">
          <q-input v-if="invoice.method!=='onchain'" filled dense readonly :model-value="invoice.payment_request" label="Payment request" @focus="$event.target.select()" />
          <q-btn v-if="invoice.method==='fiat'" flat color="primary" icon-right="open_in_new" label="Open checkout" class="q-mt-md" @click="open(invoice.payment_request)" :disable="busy" />
        </template>
        <p v-if="invoice.status==='creating'">{{invoice.method==='onchain'?'The address reservation was not confirmed. Ask the owner to review it before starting another sale.':'The provider has not confirmed this checkout. Check with the terminal owner before paying again.'}}</p>
        <p v-if="invoice.status==='paid'">Thank you for your purchase.</p><p v-if="invoice.status==='failed'">Payment was not confirmed. Check the sale before starting again.</p>
      </q-card-section>
      <q-card-actions v-if="terminal?.role!=='display'" align="center">
        <q-btn v-if="invoice.status==='pending'" outline color="grey" :label="invoice.onchain?'Copy address':invoice.method==='lightning'?'Copy invoice':'Copy URL'" @click="copy(invoice.onchain?.address||invoice.payment_request)" :disable="busy" />
        <q-btn flat label="Print order" @click="run(()=>print(invoice,true))" :disable="busy" /><q-btn v-if="invoice.status==='paid'" flat label="Print receipt" @click="run(()=>print(invoice))" :disable="busy" />
        <q-btn v-if="invoice.status==='paid'||invoice.status==='failed'" color="primary" :label="receiptOnly?'Close receipt':'Next sale'" @click="closeCheckout" /><template v-else><q-btn flat label="Check status" @click="poll" :disable="busy" /><q-btn flat color="grey" label="Close" @click="closeCheckout" /></template>
      </q-card-actions>
    </q-card>
  </q-dialog>

  <q-dialog :model-value="!!printPrompt" @update:model-value="printPrompt=null">
    <q-card v-if="printPrompt" class="lnbits__dialog-card">
      <q-card-section><h2 class="text-h6 q-ma-none">Print receipt</h2></q-card-section>
      <q-card-actions align="center">
        <q-btn color="primary" label="Print receipt" @click="run(()=>print(printPrompt))" :disable="busy" />
        <q-btn outline color="primary" label="Print order" @click="run(()=>print(printPrompt,true))" :disable="busy" />
        <q-btn flat color="grey" label="Close" @click="printPrompt=null" :disable="busy" />
      </q-card-actions>
    </q-card>
  </q-dialog>

  <q-dialog position="bottom" :model-value="showHistory||showHeld" @update:model-value="showHistory=false;showHeld=false">
    <q-card class="lnbits__dialog-card">
      <q-card-section class="row items-center justify-between"><h2 class="text-h6 q-ma-none">{{showHeld?'Carts on hold':'Receipts'}}</h2><q-btn flat round dense icon="close" @click="showHistory=false;showHeld=false" aria-label="Close" /></q-card-section>
      <q-card-section>
        <q-list v-if="showHeld" separator>
          <p v-if="!held.length">No held carts on this device.</p>
          <q-item v-for="c in held" :key="c.id"><q-item-section>{{c.name}}</q-item-section><q-item-section side><div class="row"><q-btn flat label="Resume" @click="resume(c.id)" :disable="busy" /><q-btn flat color="negative" label="Remove" @click="removeHeld(c.id)" :disable="busy" /></div></q-item-section></q-item>
        </q-list>
        <q-list v-else separator>
          <p v-if="!history.length">No sales yet.</p>
          <q-item v-for="c in history" :key="c.id" clickable @click="viewReceipt(c)" :disable="busy"><q-item-section><q-item-label>{{timestamp(c.created_at)}}</q-item-label><q-item-label caption>{{c.method}} · {{c.status}}</q-item-label><q-item-label v-if="receiptRate(c)" caption>{{receiptRate(c)}} at sale</q-item-label></q-item-section><q-item-section side>{{money(c.sale.total_minor,c.sale.currency)}}<q-item-label v-if="valueNow(c,historyRates)" caption>Now: {{valueNow(c,historyRates)}}</q-item-label></q-item-section></q-item>
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
          <tbody><tr v-for="c in sales.rows" :key="c.id"><td>{{timestamp(c.created_at)}}<div v-if="!salesTerminal.id" class="text-caption">{{c.terminal_name}}</div></td><td>{{money(c.sale.total_minor,c.sale.currency)}}<div v-if="receiptRate(c)" class="text-caption">{{receiptRate(c)}} at sale</div><div v-if="valueNow(c,salesRates)" class="text-caption">Now: {{valueNow(c,salesRates)}}</div></td><td>{{c.method}}</td><td>{{c.status}}<div v-for="(p,k) in c.payouts" :key="k" class="text-caption">{{k}}: {{p.state}} · {{p.amount_sat}} sats</div></td><td><q-btn flat label="Check" @click="reconcile(c)" :disable="busy" /><q-btn flat label="Receipt" @click="printOwnerReceipt(c)" :disable="busy||c.status!=='paid'" /></td></tr></tbody>
        </q-markup-table>
        <p class="text-caption q-mt-md">Shares marked “review” or “pending” need checking in the wallet. PoS never resends an uncertain payment automatically.</p><p v-if="error" role="alert" class="text-negative">{{error}}</p>
      </q-card-section>
      <q-card-actions align="right"><q-btn flat label="Previous" @click="pageSales(-50)" :disable="busy||offset===0" /><span>{{sales.rows.length?offset+1:0}}–{{offset+sales.rows.length}}</span><q-btn flat label="Next" @click="pageSales(50)" :disable="busy||offset+50>=sales.total" /></q-card-actions>
    </q-card>
  </q-dialog>
  <q-dialog :model-value="!!confirmation" persistent>
    <q-card v-if="confirmation" class="lnbits__dialog-card"><q-card-section>{{confirmation.message}}</q-card-section><q-card-actions align="right"><q-btn flat label="Cancel" @click="answer(false)" /><q-btn color="primary" label="Confirm" @click="answer(true)" /></q-card-actions></q-card>
  </q-dialog>
</q-layout>
</template>

<style>
/* Layout only. Core's Quasar and LNbits styles own the appearance. */
.pos-layout {height:100dvh}
.cashier-page {padding-bottom:80px}
.catalog-filter {width:240px;max-width:65%}
.tile-size {width:100px;margin:8px 16px}
.product-grid {--pos-tile-size:160px;display:grid;grid-template-columns:repeat(auto-fill,var(--pos-tile-size));justify-content:center;gap:8px}
.tiles-80 {--pos-tile-size:80px}
.tiles-120 {--pos-tile-size:120px}
.tiles-200 {--pos-tile-size:200px}
.tiles-240 {--pos-tile-size:240px}
.product-tile {min-width:0;overflow:visible}
.product-image {height:calc(var(--pos-tile-size) - 36px)}
.product-image img {width:100%;height:100%;object-fit:cover}
.product-title {overflow-wrap:anywhere;line-height:1.2}
.cart-item-name {min-width:0;overflow-wrap:anywhere}
.cart-toolbar {z-index:1}
.keypad {max-width:480px;margin:0 auto}
.keypad-grid {display:grid;grid-template-columns:repeat(4,minmax(0,1fr));grid-template-rows:repeat(4,minmax(56px,1fr));grid-auto-flow:row;gap:8px;min-height:40vh}
.keypad-grid .q-btn:nth-child(3n+1) {grid-column:1}
.keypad-grid .q-btn:nth-child(3n+2) {grid-column:2}
.keypad-grid .q-btn:nth-child(3n) {grid-column:3}
.keypad-grid .q-btn.keypad-plus {grid-column:4;grid-row:1}
.keypad-grid .q-btn.keypad-ok {grid-column:4;grid-row:2/5}
.payment-button {min-height:64px}
.q-dialog .settings-dialog {width:560px;max-width:calc(100vw - 32px);max-height:90vh}
.q-dialog .item-dialog {width:500px;max-width:calc(100vw - 32px)}
.q-dialog .wide-dialog {width:780px;max-width:calc(100vw - 32px)}
.qr {display:block;width:360px;max-width:100%;height:auto;margin-left:auto;margin-right:auto}
.small-qr {width:260px}
@media(max-width:599px) {
  .product-grid {grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}
  .product-image {height:85px}
  .product-tile {font-size:11px}
  .product-tile .q-btn__content {min-width:0}
  .keypad .text-h3 {font-size:2.5rem}
}
</style>
