// The iframe has no direct network access. Core owns authentication and permissions.
export function createBridge(parent=window.parent, origin=new URL(window.location.href).origin) {
  let connection;
  const listeners=new Set();
  function connect() {
    if (connection) return connection;
    connection=new Promise((resolve,reject)=>{
      const id=crypto.randomUUID(),channel=new MessageChannel();
      const timer=setTimeout(()=>{channel.port1.close();connection=null;reject(Error('Open Bolt Till inside LNbits.'));},15000);
      channel.port1.onmessage=e=>{
        if (e.data?.type==='lnbits-extension:connected' && e.data.id===id) {
          clearTimeout(timer); resolve(channel.port1);
        }
        if (e.data?.type==='lnbits-extension:event') for (const listener of listeners) listener(e.data);
      };
      channel.port1.start();
      parent.postMessage({type:'lnbits-extension:connect',id},origin,[channel.port2]);
    });
    return connection;
  }
  async function request(action,fields={}) {
    const port=await connect(),id=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{port.removeEventListener('message',receive);reject(Error('Request timed out. Keep this checkout and check its status before trying again.'));},30000);
      function receive(event) {
        const result=event.data;
        if (result?.type!=='lnbits-extension:response' || result.id!==id) return;
        clearTimeout(timeout);port.removeEventListener('message',receive);
        if (!result.ok) reject(Error('LNbits could not complete this request. Check permissions and connection.'));
        else resolve(result.data);
      }
      port.addEventListener('message',receive);
      port.postMessage(JSON.parse(JSON.stringify({...fields,type:'lnbits-extension:request',id,action})));
    });
  }
  async function api(path,method='GET',body=null) {
    const result=await request('api',{path:`/api/v1/ext/pos${path}`,method,body});
    if (!result || result.ok!==true) throw Error(result?.error || 'Request failed.');
    return result.data;
  }
  return {request,api,onEvent(listener){listeners.add(listener);return ()=>listeners.delete(listener);},close:async()=>{if(connection)(await connection).close();listeners.clear();connection=null;}};
}
