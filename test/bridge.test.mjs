import test from 'node:test';
import assert from 'node:assert/strict';
import {createBridge} from '../ui/bridge.js';

test('bridge correlates simultaneous requests over one channel',async()=>{
  let remote,connections=0;
  const requests=[];
  const bridge=createBridge({postMessage(message,origin,ports){
    connections++;assert.equal(origin,'https://pos.example');
    remote=ports[0];remote.onmessage=event=>{
      requests.push(event.data);
      if(requests.length===2)for(const r of requests.reverse())remote.postMessage({type:'lnbits-extension:response',id:r.id,ok:true,data:{ok:true,data:r.path}});
    };
    remote.postMessage({type:'lnbits-extension:connected',id:message.id});
  }},'https://pos.example');
  try {
    assert.deepEqual(await Promise.all([bridge.api('/terminals'),bridge.api('/metadata')]),['/api/v1/ext/pos/terminals','/api/v1/ext/pos/metadata']);
    assert.equal(connections,1);
  }finally{await bridge.close();remote?.close();}
});

test('bridge does not expose parent exception details',async()=>{
  let remote;
  const bridge=createBridge({postMessage(message,origin,ports){
    remote=ports[0];remote.onmessage=event=>remote.postMessage({type:'lnbits-extension:response',id:event.data.id,ok:false,error:'secret-wallet-key'});
    remote.postMessage({type:'lnbits-extension:connected',id:message.id});
  }},'https://pos.example');
  try {await assert.rejects(bridge.api('/terminals'),error=>!error.message.includes('secret-wallet-key'));}
  finally{await bridge.close();remote?.close();}
});
