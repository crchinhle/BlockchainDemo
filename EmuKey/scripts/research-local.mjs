import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import net from 'node:net';
const root=fileURLToPath(new URL('../',import.meta.url));
const children=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function occupied(port){return new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port});s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));});}
function launch(name,cwd,args,quiet=false){const child=spawn(process.execPath,args,{cwd,windowsHide:true,stdio:quiet?'ignore':'inherit'});children.push(child);child.on('error',()=>{console.error(name+' failed to start');process.exitCode=1;});return child;}
async function command(exe,args,cwd=root){await new Promise((ok,bad)=>{const p=spawn(exe,args,{cwd,windowsHide:true,stdio:'inherit'});p.on('error',bad);p.on('exit',code=>code===0?ok():bad(new Error('Command failed: '+exe+' exit '+code)));});}
let stopping=false;
function stop(){if(stopping)return;stopping=true;for(const c of children)c.kill();console.log('Stopped research processes. Docker data volumes preserved.');}
process.on('SIGINT',()=>{stop();process.exit();});process.on('SIGTERM',()=>{stop();process.exit();});process.on('exit',stop);
try{
 for(const port of [58545,3100,5174])if(await occupied(port))throw new Error('Port '+port+' is already occupied. Stop the previous research process before starting a second instance.');
 await command('docker',['compose','-f','compose.research.yml','up','-d','postgres','redis']);
 await command('docker',['compose','-f','compose.research.yml','run','--rm','database-initialize']);
 const backend=resolve(root,'backend'),frontend=resolve(root,'frontend'),contracts=resolve(backend,'contracts');
 // Hardhat prints public development keys on startup; discard its entire output.
 const evm=launch('Local EVM',contracts,[resolve(contracts,'node_modules/hardhat/dist/src/cli.js'),'node','--hostname','127.0.0.1','--port','58545'],true);
 for(let i=0;i<100&&!await occupied(58545);i++){if(evm.exitCode!==null)throw new Error('Local EVM exited');await wait(200);}
 if(!await occupied(58545))throw new Error('Local EVM startup timeout');
 await command(process.execPath,['dist/entrypoints/research/main.js','--setup'],backend);
 launch('Worker',backend,['dist/entrypoints/research/main.js','--worker']);
 launch('API',backend,['dist/entrypoints/research/main.js']);
 launch('Web',frontend,[resolve(frontend,'node_modules/vite/bin/vite.js'),'--config','vite.research.config.ts']);
 console.log('Open http://127.0.0.1:5174/research.html');
 console.log('Login credentials: EmuKey/backend/.research-local/login.json (do not share).');
 console.log('Keep this terminal open; Ctrl+C stops processes, preserves PostgreSQL/Redis volumes.');
}catch(error){console.error(error.message);stop();process.exitCode=1;}
