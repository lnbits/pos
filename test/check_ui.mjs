// Execute core's real classic scripts in HTML order, with browser startup stubs.
// This checks library startup, not rendering or browser interaction.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

class Element {
  style={};
  classes=new Set();
  classList={add:(...names)=>names.forEach(name=>this.classes.add(name)),remove:(...names)=>names.forEach(name=>this.classes.delete(name)),contains:name=>this.classes.has(name)};
  setAttribute(){}
  removeAttribute(){}
  addEventListener(){}
}

try {
  const core=process.env.LNBITS_CORE_PATH;
  if(!core)throw Error('Set LNBITS_CORE_PATH to the core checkout serving PoS.');
  const document={body:null,location:{href:'http://localhost:5000/ext-frame/pos/0'},documentElement:new Element(),createElement:()=>new Element(),addEventListener:()=>{}};
  const runtime=vm.createContext({document,console,navigator:{userAgent:'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36',maxTouchPoints:0},Element,HTMLElement:Element,FileList:class{},File,Blob,URL,Event,XMLHttpRequest:class{open(){}},setTimeout,clearTimeout,setInterval,clearInterval});
  vm.runInContext('window=globalThis; self=window; top={}; addEventListener=()=>{};',runtime);
  runtime.getComputedStyle=element=>{
    if(!(element instanceof Element))throw TypeError('getComputedStyle requires an Element; the page body is not ready.');
    return {getPropertyValue:()=>''};
  };
  for(const name of ['localStorage','sessionStorage'])Object.defineProperty(runtime,name,{get(){throw Error('Storage is unavailable in the sandbox.');}});

  const html=readFileSync(new URL('../ui/index.html',import.meta.url),'utf8');
  const loaded=[];
  for(const [,tag,attributes] of html.matchAll(/<(body|script)\b([^>]*)>/gi)){
    if(tag==='body'){document.body=new Element();continue;}
    if(/type="module"/.test(attributes))continue;
    const source=attributes.match(/src="([^"]+)"/)?.[1];
    const name=source?.match(/^\/ext-assets\/pos\/_lnbits\/(vue\.global\.prod\.js|quasar\.umd\.prod\.js)$/)?.[1];
    assert.ok(name,'Unexpected classic script in UI entrypoint.');
    vm.runInContext(readFileSync(path.join(core,'lnbits/static/vendor',name),'utf8'),runtime,{filename:name});
    loaded.push(name);
  }
  assert.deepEqual(loaded,['vue.global.prod.js','quasar.umd.prod.js']);
  assert.ok(runtime.Quasar?.QBtn && runtime.Quasar?.QDialog && runtime.Quasar?.QSelect,'Core components must be registered.');
  runtime.Quasar.Dark.set(true);
  assert.ok(document.body.classes.has('body--dark'));
  runtime.Quasar.Dark.set(false);
  assert.ok(document.body.classes.has('body--light'));
  assert.equal(document.body.classes.has('body--dark'),false);
  console.log('PASS: core Vue and Quasar start in entrypoint order; dark/light mode works without origin storage.');
} catch(error) {
  console.error('FAIL:',error.message);
  process.exitCode=1;
}
