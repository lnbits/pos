// Core limits each local-storage value to 1 KiB. Commit the index after chunks.
export function cartStorage(bridge) {
  const read=async key=>{const r=await bridge.request('storage.local.get',{key});return r.value || '';};
  const write=(key,value)=>bridge.request('storage.local.set',{key,value});
  const remove=key=>bridge.request('storage.local.remove',{key});
  async function index() {
    try { const rows=JSON.parse(await read('held-index') || '[]'); return Array.isArray(rows)?rows.filter(r=>/^[a-f0-9-]{36}$/.test(r.id)&&Number.isInteger(r.chunks)&&r.chunks>0&&r.chunks<=16).slice(0,6):[]; }
    catch {return [];}
  }
  return {
    async list() {return index();},
    async hold(cart,name) {
      const rows=await index();if(rows.length>=6) throw Error('Resume or remove a held cart first (maximum six).');
      const value=JSON.stringify(cart),parts=[];let part='';
      for (const char of value) {if(new TextEncoder().encode(part+char).length>900){parts.push(part);part='';}part+=char;}
      if(part)parts.push(part);
      if(parts.length>16)throw Error('This cart is too large to hold.');
      const id=crypto.randomUUID();let written=0;
      try {
        for(const [i,p] of parts.entries()){await write(`held.${id}.${i}`,p);written++;}
        const next=[...rows,{id,name:String(name).trim().slice(0,36),chunks:parts.length}];
        if(new TextEncoder().encode(JSON.stringify(next)).length>1024)throw Error('Held cart names exceed device storage. Use a shorter note.');
        await write('held-index',JSON.stringify(next));return next;
      } catch(error) {for(let i=0;i<written;i++)await remove(`held.${id}.${i}`).catch(()=>{});throw error;}
    },
    async load(id) {
      const row=(await index()).find(r=>r.id===id);if(!row)throw Error('Held cart is unavailable.');
      let value='';for(let i=0;i<row.chunks;i++){const p=await read(`held.${id}.${i}`);if(!p)throw Error('Held cart has expired.');value+=p;}
      const result=JSON.parse(value);if(!Array.isArray(result.items))throw Error('Held cart is invalid.');return result;
    },
    async remove(id) {
      const rows=await index(),row=rows.find(r=>r.id===id);
      await write('held-index',JSON.stringify(rows.filter(r=>r.id!==id)));
      if(row)for(let i=0;i<row.chunks;i++)await remove(`held.${id}.${i}`);
    }
  };
}

export function appearanceStorage(bridge) {
  const normalize=value=>({mono:value?.mono===true,tileSize:[80,120,160,200,240].includes(value?.tileSize)?value.tileSize:160});
  let pending=Promise.resolve();
  return {
    async load() {
      try {return normalize(JSON.parse((await bridge.request('storage.local.get',{key:'appearance'})).value||'{}'));}
      catch {return normalize(null);}
    },
    save(value) {
      const data=JSON.stringify(normalize(value));
      pending=pending.catch(()=>{}).then(()=>bridge.request('storage.local.set',{key:'appearance',value:data}));
      return pending;
    }
  };
}

export function checkoutSession(bridge,link) {
  const key=`checkout.${link}`;
  const read=async name=>(await bridge.request('storage.session.get',{key:name})).value;
  const write=(name,value)=>bridge.request('storage.session.set',{key:name,value});
  return {
    async save(attempt) {
      const value=JSON.stringify(attempt),chunks=Math.ceil(value.length/3500);
      if(chunks>16)throw Error('Checkout is too large. Reduce cart notes.');
      for(let i=0;i<chunks;i++)await write(`${key}.${i}`,value.slice(i*3500,(i+1)*3500));
      await write(key,String(chunks));
    },
    async load() {
      const chunks=Number(await read(key));if(!chunks)return null;
      if(!Number.isInteger(chunks)||chunks<1||chunks>16)throw Error('Saved checkout is invalid.');
      let value='';for(let i=0;i<chunks;i++)value+=await read(`${key}.${i}`)||'';
      const attempt=JSON.parse(value);
      if(attempt.link!==link||!Array.isArray(attempt.items))throw Error('Saved checkout is invalid.');
      return attempt;
    },
    clear:()=>write(key,'')
  };
}
