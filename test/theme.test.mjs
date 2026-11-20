import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCoreTheme} from '../ui/theme.js';

function themeEnvironment(t){
  const styles=new Map(),classes=new Set(),body={dataset:{},style:{setProperty:(key,value)=>styles.set(key,value),removeProperty:key=>styles.delete(key)},classList:{toggle(name,enabled){if(enabled)classes.add(name);else classes.delete(name);}}};
  const state={dark:null};
  const globals={document:{body},window:{Quasar:{Dark:{set(value){state.dark=value;}}}},CSS:{supports:(_property,value)=>/^#[a-f0-9]{6}$/i.test(value)}};
  for(const [name,value] of Object.entries(globals)){
    const original=Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{value,configurable:true});
    t.after(()=>original?Object.defineProperty(globalThis,name,original):delete globalThis[name]);
  }
  return {styles,classes,body,state};
}

test('core theme changes update dark mode, named theme, gradient and colors without stale overrides',t=>{
  const {styles,classes,body,state}=themeEnvironment(t);
  applyCoreTheme({name:'bitcoin',dark:true,gradient:true,colors:{primary:'#ff9900',secondary:'#555555'}});
  assert.equal(state.dark,true);assert.equal(body.dataset.theme,'bitcoin');assert.ok(classes.has('gradient-bg'));
  assert.equal(styles.get('--q-primary'),'#ff9900');assert.equal(styles.get('--q-secondary'),'#555555');
  applyCoreTheme({name:'mint',dark:false,gradient:false,colors:{primary:'#00ff99'}});
  assert.equal(state.dark,false);assert.equal(body.dataset.theme,'mint');assert.equal(classes.size,0);
  assert.deepEqual([...styles],[['--q-primary','#00ff99']]);
});

test('theme accepts only core color names and valid bounded CSS colors',t=>{
  const {styles,state}=themeEnvironment(t);
  applyCoreTheme({dark:'false',colors:{primary:'url(https://external.test/image)',secondary:'#'+('f'.repeat(130)),accent:42,background:'#ffffff',positive:'#00ff00'}});
  assert.equal(state.dark,false);assert.deepEqual([...styles],[['--q-positive','#00ff00']]);
  assert.doesNotThrow(()=>applyCoreTheme(null));
});
