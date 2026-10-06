const fs=require('node:fs'),vm=require('node:vm');
for(const path of ['android/app/src/main/assets/index.html','store-portal/index.html','store-portal/admin.html']){
 const html=fs.readFileSync(path,'utf8');let i=0;for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)){new vm.Script(match[1],{filename:`${path}:script${++i}`})}console.log(`PASS syntax: ${path} (${i} scripts)`);
}
JSON.parse(fs.readFileSync('store-portal/vercel.json','utf8'));
