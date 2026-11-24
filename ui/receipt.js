// A status poll may return the same paid checkout repeatedly.
export function createReceiptPrompt() {
  let promptedId='';
  return (checkout,{role,enabled,checkoutId,history})=>{
    if(role!=='cashier' || enabled!==true || history || !checkoutId || checkout?.id!==checkoutId || checkout.status!=='paid' || promptedId===checkoutId)return false;
    promptedId=checkoutId;
    return true;
  };
}
