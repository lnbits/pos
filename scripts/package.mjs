import {cp,mkdir,readFile,readdir,stat,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(await readFile(path.join(root,'config.json'),'utf8'));
const artifact=path.join(root,'dist',`pos-${config.version}.zip`);
const stage=path.join(root,'dist',`package-${Date.now()}`);
const destination=path.join(stage,'pos');
await mkdir(destination,{recursive:true});
await mkdir(path.join(destination,'ui'));
for(const file of ['config.json','LICENSE','THIRD_PARTY_NOTICES.txt','README.md','wasm','storage','static','ui/index.html']){
  await cp(path.join(root,file),path.join(destination,file),{recursive:true});
}
async function inspect(directory){for(const entry of await readdir(directory,{withFileTypes:true})){
  const file=path.join(directory,entry.name);
  if(entry.isSymbolicLink())throw Error('Symlinks are not allowed in releases.');
  if(entry.isDirectory())await inspect(file);
  else if(/\.(py|pyc|pyo|so|pyd)$/i.test(entry.name))throw Error('Python/native code is not allowed in a WASM package.');
}}
await inspect(destination);
if((await stat(path.join(destination,'wasm/pos.wasm'))).size<8)throw Error('Build the WASM component first.');
await rm(artifact,{force:true});
execFileSync('zip',['-qr',artifact,'pos'],{cwd:stage});
await rm(stage,{recursive:true});
console.log(artifact);
