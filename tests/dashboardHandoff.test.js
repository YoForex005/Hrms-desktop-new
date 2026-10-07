import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { openEmployeeDashboard } = require('../electron/dashboardHandoff.cjs');
const { validateRequest } = require('../electron/apiBridge.cjs');
const code = 'a'.repeat(64);
function fixture(overrides = {}) {
    const opened = [], requests = [];
    const options = { getToken: () => 'fixture-desktop-secret', webBase: 'https://emptrakr.com',
        allowed: url => url === 'https://emptrakr.com/desktop/dashboard',
        requestApi: async (token, request) => { requests.push({ token, request }); return { status: 201, body: JSON.stringify({ code, expiresAt: new Date(Date.now() + 120000) }) }; },
        openExternal: async url => { opened.push(url); }, ...overrides };
    return { opened, requests, options };
}
test('dashboard uses trusted desktop session and puts only a temporary code in the fragment', async () => {
    const f = fixture(); assert.deepEqual(await openEmployeeDashboard(f.options), { ok: true });
    assert.deepEqual(f.requests, [{ token: 'fixture-desktop-secret', request: { path: '/auth/dashboard-handoff', method: 'POST', body: '{}' } }]);
    const url = new URL(f.opened[0]); assert.equal(url.origin, 'https://emptrakr.com'); assert.equal(url.pathname, '/desktop/dashboard'); assert.equal(url.search, '');
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('handoff'), code);
    assert.ok(!f.opened[0].includes('fixture-desktop-secret'));
});
test('missing, revoked, unsupported and unreachable sessions never open another user dashboard', async () => {
    for (const overrides of [{ getToken: () => null }, ...[401,403,404,503].map(status => ({requestApi: async () => ({status, body:'{}'})})),
        { requestApi: async () => { throw new Error('raw secret'); } }, {openExternal:async()=>{throw new Error('raw URL');}}]) {
        const f=fixture(overrides); const result=await openEmployeeDashboard(f.options); assert.equal(result.ok,false); assert.ok(!result.error.includes('raw')); assert.equal(f.opened.length,0);
    }
});
test('malformed and expired handoffs and changed accounts are blocked', async () => {
    for (const grant of [{code:'invalid',expiresAt:new Date(Date.now()+1000)}, {code,expiresAt:new Date(Date.now()-1000)}, {code,expiresAt:'bad'}]) {
        const f=fixture({requestApi:async()=>({status:201,body:JSON.stringify(grant)})}); assert.equal((await openEmployeeDashboard(f.options)).ok,false); assert.equal(f.opened.length,0);
    }
    let token='old';const f=fixture({getToken:()=>token,requestApi:async()=>{token='new';return{status:201,body:JSON.stringify({code,expiresAt:new Date(Date.now()+1000)})};}});
    assert.equal((await openEmployeeDashboard(f.options)).ok,false);assert.equal(f.opened.length,0);
    const blocked=fixture({allowed:()=>false});assert.equal((await openEmployeeDashboard(blocked.options)).ok,false);assert.equal(blocked.opened.length,0);
});
test('bridge exposes issuance only, never browser exchange or arbitrary authentication paths', () => {
    assert.equal(validateRequest({method:'POST',path:'/auth/dashboard-handoff',body:'{}'}).method,'POST');
    for(const path of ['/auth/dashboard-handoff/exchange','/auth/dashboard-handoff/preview','/auth/dashboard-handoff/cancel','/auth/dashboard-handoff/../exchange']) assert.throws(()=>validateRequest({method:'POST',path}));
});
test('actual trusted main IPC handler ignores renderer URL and token payloads', async () => {
    const source=readFileSync(new URL('../electron/main.js',import.meta.url),'utf8');
    const registration=source.match(/    handleTrusted\('open-dashboard', [\s\S]*?\n    \}\)\);/)?.[0];assert.ok(registration);
    const f=fixture();let handler;
    vm.runInNewContext(registration,{WEB_BASE:f.options.webBase,API_BASE:'https://api.emptrakr.com/api',sessionAuthToken:'fixture-desktop-secret',
        handleTrusted(channel,fn){assert.equal(channel,'open-dashboard');handler=fn;},isAllowedExternalUrl:f.options.allowed,shell:{openExternal:f.options.openExternal},
        require(name){return name==='./dashboardHandoff.cjs'?{openEmployeeDashboard}: {requestApi:(_base,token,request)=>f.options.requestApi(token,request)};}});
    assert.equal((await handler({},'http://localhost:3000','forged-token')).ok,true);assert.equal(f.opened.length,1);assert.equal(new URL(f.opened[0]).pathname,'/desktop/dashboard');
});
test('real dashboard button awaits IPC result and does not use an unsafe browser fallback', async () => {
    const ts=require('typescript');const source=readFileSync(new URL('../src/pages/Dashboard.tsx',import.meta.url),'utf8');
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
    const calls=[],state=[];const jsx=(type,props)=>({type,props});
    function render(window) {
        const exports={};vm.runInNewContext(code,{exports,window,require(name){
            if(name==='react')return{useState:value=>[value,next=>state.push(next)],useEffect(){}};
            if(name==='react/jsx-runtime')return{jsx,jsxs:jsx};
            if(name==='../hooks/useTimer')return{useTimer:()=>({status:'stopped',loading:false,connection:{connected:true}}),formatDuration:()=> '00:00:00'};
            if(name==='../hooks/useAppTracker')return{useAppTracker(){}};throw new Error(name);
        }});
        function find(node){if(Array.isArray(node))return node.map(find).find(Boolean);if(!node||typeof node!=='object')return;if(node.type==='button'&&node.props.children==='View Dashboard')return node;return find(node.props?.children);}
        return find(exports.default({view:'tracker',user:{id:'employee',name:'Tanu'},onLogout(){}}));
    }
    await render({electronAPI:{openDashboard:async(...args)=>{calls.push(args);return{ok:true};}}}).props.onClick(); assert.deepEqual(calls,[[]]);
    await render({open(){throw new Error('Unsafe fallback');}}).props.onClick();assert.ok(state.includes('Open the dashboard from the EmpTrakr desktop app.'));
    await render({electronAPI:{openDashboard:async()=>({ok:false,error:'Connection unavailable'})}}).props.onClick();assert.ok(state.includes('Connection unavailable'));
});
