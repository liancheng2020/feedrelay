import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fixture, incoming } from './helpers.js';
import { createApp } from '../server/app.js';
import { freezeDigest } from '../server/digest.js';
import { Store } from '../server/store.js';

test('RD-12: deleting an update erases its summary and pending pushes, preserves usage and prevents recollection', async (t) => {
  const f = fixture(t), source = f.source(), service = f.engine.summaries;
  service.configure({ enabled: true, maxCalls: 10, maxCostCny: 1, confirmed: true });
  service.authorize(source.id, 'manual', true, true, 'captions');
  const item = f.store.put(incoming(), [f.store.source(source.id)], true, f.engine.destination);
  service.enqueue(item.id);
  await service.cycle(f.engine.destination);
  const row = service.list(item.id)[0];
  assert.equal(row.status, 'succeeded');
  const calls = service.describe().calls;
  f.store.deleteItem(item.id);
  assert.deepEqual({...f.store.get<{title:string;text:string;url:string;expired:number}>('SELECT title,text,url,expired FROM items WHERE id=?', item.id)},
    { title: '', text: '', url: '', expired: 1 });
  assert.equal(f.store.get('SELECT result FROM summaries WHERE id=?', row.id)!.result, '');
  assert.equal(f.store.get('SELECT text FROM items WHERE id=?', row.output!.item_id)!.text, '');
  assert.equal(f.store.claimDelivery(f.engine.destination), undefined);
  assert.equal(service.describe().calls, calls);
  assert.throws(() => service.request(item.id, 'captions'), /CONTENT_EXPIRED/);
  assert.equal(f.store.put(incoming(), [source], true, f.engine.destination).id, item.id);
  assert.equal(f.store.get('SELECT text FROM items WHERE id=?', item.id)!.text, '');
  const reopened = new Store(f.dir, 'demo', f.now);
  assert(reopened.get('SELECT 1 FROM meta WHERE key=?', `item-deleted:${item.id}`));
  reopened.close();
  f.store.deleteItem(item.id);
});

test('RD-13: item delete API requires session, CSRF and confirmation, updates list totals and denies old detail links', async (t) => {
  const f = fixture(t), source = f.source(), item = f.store.put(incoming(), [source], false, 'demo');
  const server = createApp(f.store, f.config, f.engine).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/api`;
  let cookie = '', csrf = '';
  const api = async (path:string, method='GET', body?:object, token=csrf) => {
    const r = await fetch(base+path,{ method, headers:{ Cookie:cookie, Origin:f.config.origin,
      'X-CSRF-Token':token, 'Content-Type':'application/json' }, ...(body ? {body:JSON.stringify(body)} : {}) });
    if(r.headers.getSetCookie().length) cookie = r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
    return r;
  };
  assert.equal((await api(`/items/${item.id}`,'DELETE',{confirmed:true})).status,403);
  csrf = (await (await api('/login','POST',{password:'demo'})).json()).csrf;
  assert.equal((await api(`/items/${item.id}`,'DELETE',{},'bad-token')).status,403);
  assert.equal((await api(`/items/${item.id}`,'DELETE',{})).status,400);
  assert.equal((await api('/items')).status,200);
  assert.equal((await api(`/items/${item.id}`,'DELETE',{confirmed:true})).status,200);
  const list = await (await api(`/items?source=${source.id}`)).json();
  assert.equal(list.total,0); assert.deepEqual(list.items,[]);
  assert.equal((await api(`/items/${item.id}`)).status,404);
  assert.equal((await api(`/items/${item.id}`,'DELETE',{confirmed:true})).status,200);
  assert.equal((await api('/items/missing','DELETE',{confirmed:true})).status,404);
  assert.equal(f.store.source(source.id).enabled,1);
});

test('RD-14: deleting a member prevents its frozen digest part from being delivered', (t) => {
  const f = fixture(t);
  f.store.setSettings({...f.store.settings(),digestTime:'12:00'});
  const source = f.store.changeDeliveryMode(f.source().id,'digest');
  const item = f.store.put(incoming(),[source],true,'demo');
  assert(freezeDigest(f.store,'demo'));
  f.store.deleteItem(item.id);
  assert.equal(f.store.claimDelivery('demo'),undefined);
  assert.equal(f.store.get("SELECT snapshot FROM deliveries WHERE mode='digest_part'")!.snapshot,'');
});

test('RD-15: an in-flight summary cannot publish or enqueue a push after its update is deleted', async (t) => {
  const f = fixture(t), source = f.source(), service = f.engine.summaries;
  service.configure({enabled:true,maxCalls:10,maxCostCny:1,confirmed:true});
  service.authorize(source.id,'manual',true,true,'captions');
  const item = f.store.put(incoming(),[source],false,f.engine.destination);
  let release!:()=>void, started!:()=>void;
  const ready = new Promise<void>(r=>{started=r;});
  service.transport = async()=>{
    started(); await new Promise<void>(r=>{release=r;});
    return Response.json({usage:{prompt_tokens:10,completion_tokens:10}});
  };
  service.enqueue(item.id);
  const running = service.cycle(f.engine.destination);
  await ready;
  f.store.deleteItem(item.id);
  release(); await running;
  const row = service.list(item.id)[0];
  assert.equal(row.status,'expired'); assert.equal(row.result,null); assert.equal(row.output,null);
  assert.equal(service.describe().calls,1);
});
