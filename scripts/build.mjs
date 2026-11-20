import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {parse,compileScript,compileStyle} from '@vue/compiler-sfc';
import * as vue from 'vue';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
await mkdir('build',{recursive:true});await mkdir('static',{recursive:true});
const descriptor=parse(await readFile('ui/App.vue','utf8'),{filename:'ui/App.vue'}).descriptor;
const script=compileScript(descriptor,{id:'pos-app',inlineTemplate:true,genDefaultAs:'__sfc__'});
await build({entryPoints:['ui/main.js'],bundle:true,format:'esm',target:'es2022',outfile:'static/app.js',minify:true,legalComments:'eof',plugins:[{name:'compiled-vue',setup(b){
  b.onLoad({filter:/App\.vue$/},()=>({contents:script.content+'\nexport default __sfc__;',loader:'js',resolveDir:path.join(root,'ui')}));
  // Quasar and the precompiled app must share core's single Vue runtime.
  b.onResolve({filter:/^vue$/},()=>({path:'vue',namespace:'core-vue'}));
  b.onLoad({filter:/.*/,namespace:'core-vue'},()=>({contents:Object.keys(vue).filter(name=>name!=='default' && /^[\w$]+$/.test(name)).map(name=>`export const ${name} = window.Vue.${name};`).join('\n'),loader:'js'}));
}}]});
const style=compileStyle({source:descriptor.styles.map(s=>s.content).join('\n'),id:'pos-app',filename:'ui/App.vue'});
if(style.errors.length)throw new Error(String(style.errors));
await writeFile('static/app.css',style.code);
const licenses=[['Vue','vue/LICENSE'],['QRCode','qrcode/license'],['DijkstraJS','dijkstrajs/LICENSE.md'],['ComponentizeJS / StarlingMonkey embedding','@bytecodealliance/componentize-js/LICENSE']];
let notices='Third-party software included in PoS\n\n';
for(const [name,file] of licenses)notices+=`${name}\n${await readFile(path.join('node_modules',file),'utf8')}\n\n`;
notices+='The WASM component embeds unmodified upstream StarlingMonkey/SpiderMonkey code.\nSpiderMonkey is available under the Mozilla Public License 2.0:\nhttps://www.mozilla.org/MPL/2.0/\nEngine source and pinned upstream dependencies:\nhttps://github.com/bytecodealliance/ComponentizeJS/tree/v0.23.0\nhttps://github.com/bytecodealliance/StarlingMonkey\n';
await writeFile('THIRD_PARTY_NOTICES.txt',notices);
await build({entryPoints:['src/index.js'],bundle:true,format:'esm',platform:'neutral',target:'es2022',external:['lnbits:*'],outfile:'build/guest.js'});
execFileSync(path.join(root,'node_modules/.bin/jco'),['componentize','build/guest.js','--disable','all','--enable','clocks','--enable','random','--enable','stdio','--wit','wasm/lnbits-extension.wit','--world-name','pos','-o','wasm/pos.wasm'],{stdio:'inherit',timeout:600000});
console.log('Built browser assets and wasm/pos.wasm.');
