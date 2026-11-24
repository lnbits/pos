import {storageGet,storageSet,storageDelete,storageGetPaginated,createInvoicePublic,invoiceStatus,refreshPayment,createFiatInvoicePublic,listFiatProviders,listUserWallets,payInvoice,payLnurl,websocketPublish,randomId,now} from 'lnbits:extension/host';
import {listCurrencies,rate} from 'lnbits:extension/utils-currencies';
import {reserveAddressPublic,paymentStatus} from 'lnbits:extension/onchain';
import {createPos,invoke} from './pos.js';

const pos=createPos({
  db:{
    get(table,id) { const value=storageGet({table,id}).dataJson; return value ? JSON.parse(value) : null; },
    set(table,row) { storageSet({table,dataJson:JSON.stringify(row)}); },
    delete(table,id) { storageDelete({table,id}); },
    list(table,filters,limit,offset) {
      const page=storageGetPaginated({table,filtersJson:JSON.stringify(filters),search:'',searchFields:[],sortBy:table==='checkouts' ? 'created_at' : 'id',descending:true,limit,offset});
      return {rows:JSON.parse(page.rowsJson),total:Number(page.total)};
    }
  },
  id:prefix=>randomId({prefix}).id,
  now:()=>Number(now().timestamp),
  wallets:()=>listUserWallets({walletType:undefined}).wallets.map(w=>({id:w.id,name:w.name,currency:w.currency,wallet_type:w.walletType,onchain_network:w.onchainNetwork,receiving_ready:w.receivingReady})),
  currencies:()=>listCurrencies().currencies,
  providers:()=>listFiatProviders().providers,
  rate:currency=>rate({currency}),
  reserveAddress:(sourceId,checkoutId)=>reserveAddressPublic({table:'checkouts',sourceId,checkoutId}),
  onchainStatus:(walletId,sourceId,checkoutId,address,statusToken)=>paymentStatus({walletId,sourceId,checkoutId,address,statusToken}),
  invoice:(sourceId,amount,currency,memo)=>createInvoicePublic({sourceId,amount,currency,memo,extra:[],descriptionHash:undefined,unhashedDescription:undefined}),
  invoiceStatus:(paymentHash,sourceId)=>invoiceStatus({paymentHash,sourceId}),
  refreshPayment:(walletId,checkingId)=>refreshPayment({walletId,checkingId}),
  fiatInvoice:(sourceId,amount,currency,memo)=>createFiatInvoicePublic({sourceId,amount,currency,memo}),
  payInvoice:(walletId,paymentRequest,maxSat,description)=>payInvoice({walletId,paymentRequest,maxSat:BigInt(maxSat),description,extra:[]}),
  payLnurl:(walletId,lnurl,amount)=>payLnurl({walletId,lnurl,amount,currency:'sat',description:'PoS revenue share',comment:undefined,maxSat:BigInt(amount),extra:[],fetchOnly:false}),
  publish:(itemId,data)=>websocketPublish({itemId,dataJson:JSON.stringify(data)})
});

export const metadata = json=>invoke(pos,'metadata',json);
export const listTerminals = json=>invoke(pos,'listTerminals',json);
export const terminalSettings = json=>invoke(pos,'terminalSettings',json);
export const saveTerminal = json=>invoke(pos,'saveTerminal',json);
export const disableTerminal = json=>invoke(pos,'disableTerminal',json);
export const deleteTerminal = json=>invoke(pos,'deleteTerminal',json);
export const rotateLinks = json=>invoke(pos,'rotateLinks',json);
export const getTerminal = json=>invoke(pos,'getTerminal',json);
export const createCheckout = json=>invoke(pos,'createCheckout',json);
export const checkoutStatus = json=>invoke(pos,'checkoutStatus',json);
export const publicHistory = json=>invoke(pos,'publicHistory',json);
export const historyRate = json=>invoke(pos,'historyRate',json);
export const salesRate = json=>invoke(pos,'salesRate',json);
export const saleReceipt = json=>invoke(pos,'saleReceipt',json);
export const sales = json=>invoke(pos,'sales',json);
export const reconcile = json=>invoke(pos,'reconcile',json);
export const recordPayment = json=>invoke(pos,'recordPayment',json);
