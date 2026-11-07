import assert from 'node:assert/strict';
import test from 'node:test';
import { proxyGuestRequest } from '../lib/guest-proxy.mjs';

const site = 'https://visitors.example';
const backend = 'https://owner.example';
const token = 'a'.repeat(64);
const request = (path, method = 'GET', headers = {}, body) => new Request(site + '/api/chat/' + path, {
  method, headers: { 'X-Chat-Request': '1', Origin: site, ...headers }, ...(body === undefined ? {} : { body }),
});

test('only guest push configuration, opt-in and unsubscribe pass through the gateway with the private guest session', async () => {
  for (const [path, method] of [['push/config', 'GET'], ['push/subscription', 'POST'], ['push/subscription', 'DELETE']]) {
    const payload = JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/test' });
    const response = await proxyGuestRequest(request(path, method, { Cookie: `wisal_visitor_guest=${token}` }, method === 'GET' ? undefined : payload), { backend, fetch: async (url, init) => {
      assert.equal(init.headers.get('Cookie'), `wisal_guest=${token}`);
      assert.equal(new URL(url).searchParams.get('view'), 'guest');
      if (method !== 'GET') assert.equal(await new Request(url, init).text(), payload);
      return Response.json({ ok: true });
    } });
    assert.equal(response.status, 200);
  }
  for (const [path, method] of [['push/admin', 'POST'], ['push/config', 'POST'], ['push/subscription', 'GET'], ['conversations/bulk-delete', 'POST']]) {
    assert.equal((await proxyGuestRequest(request(path, method), { backend, fetch: async () => assert.fail('must not reach backend') })).status, 403);
  }
});

test('a guest uses only the central backend, while all admin identities and cookies are stripped', async () => {
  let received;
  const response = await proxyGuestRequest(request('conversations?view=guest&backend=https://evil.example', 'GET', {
    Cookie: `wisal_admin=secret; wisal_guest=do-not-forward; wisal_visitor_guest=${token}; __Secure-auth=secret`,
    Authorization: 'Bearer owner-token', 'oai-authenticated-user-id': 'owner', 'oai-authenticated-user-email': 'owner@example.test',
  }), { backend, fetch: async (url, init) => {
    received = new Request(url, init);
    return Response.json({ conversations: [{ id: 'only-this-visitor' }] });
  } });
  assert.equal(response.status, 200);
  assert.equal(new URL(received.url).origin, backend);
  assert.equal(new URL(received.url).searchParams.get('view'), 'guest');
  assert.equal(received.headers.get('cookie'), `wisal_guest=${token}`);
  assert.equal(received.headers.get('authorization'), null);
  assert.equal(received.headers.get('oai-authenticated-user-id'), null);
  assert.equal(received.headers.get('oai-authenticated-user-email'), null);
  assert.equal(received.headers.get('origin'), backend);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal((await response.json()).conversations.length, 1);
});

test('the visitor project cannot proxy authentication, admin mode, member lists, profile writes, statuses writes or arbitrary URLs', async () => {
  let calls = 0;
  const options = { backend, fetch: async () => { calls++; return new Response(); } };
  for (const [path, method] of [
    ['auth/login', 'POST'], ['auth/logout', 'POST'], ['users?q=guest', 'GET'], ['session?view=admin', 'POST'],
    ['session?view=guest&view=admin', 'POST'], ['conversations?admin=1', 'GET'], ['statuses', 'POST'], ['statuses/abc', 'DELETE'],
    ['profile', 'PATCH'], ['conversations/abc', 'PATCH'], ['conversations/abc', 'DELETE'], ['uploads?purpose=avatar', 'POST'],
    ['uploads?purpose=status', 'POST'], ['uploads?purpose=message', 'POST'], ['https:%2F%2Fevil.example', 'GET'],
  ]) assert.equal((await proxyGuestRequest(request(path, method), options)).status, path.startsWith('https:') ? 404 : 403, path);
  assert.equal(calls, 0);
});

test('unsafe cross-site writes are rejected before setting the central backend origin', async () => {
  let calls = 0;
  const options = { backend, fetch: async () => { calls++; return new Response(); } };
  for (const headers of [{ Origin: 'https://evil.example' }, { 'X-Chat-Request': '0' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await proxyGuestRequest(request('session', 'POST', headers), options)).status, 403);
  }
  assert.equal(calls, 0);
});

test('a normalized internal Next.js URL still validates the real browser Host and Origin', async () => {
  const normalized = new Request('https://internal.example/api/chat/session', { method: 'POST', headers: { Host: 'visitors.example', Origin: site, 'X-Chat-Request': '1' } });
  assert.equal((await proxyGuestRequest(normalized, { backend, fetch: async () => Response.json({ ok: true }) })).status, 200);
  const forged = new Request('https://internal.example/api/chat/session', { method: 'POST', headers: { Host: 'visitors.example', Origin: 'https://evil.example', 'X-Chat-Request': '1' } });
  assert.equal((await proxyGuestRequest(forged, { backend })).status, 403);
});

test('only the HttpOnly guest session is reissued on the visitors origin and persists on later requests', async () => {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('Set-Cookie', `wisal_guest=${token}; Domain=owner.example; Secure; HttpOnly; Path=/; SameSite=Lax`);
  headers.append('Set-Cookie', 'wisal_admin=never-copy; Secure; HttpOnly; Path=/');
  const response = await proxyGuestRequest(request('session', 'POST'), { backend, fetch: async () => new Response('{}', { headers }) });
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0], `wisal_visitor_guest=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000; Secure`);
  assert(!cookies[0].includes('Domain='));
  assert(!cookies[0].includes('wisal_admin'));
});

test('messages, read and delivery acknowledgements and media keep their payloads and recipient-only upstream authorization', async () => {
  for (const path of ['conversations/visitor-thread/messages', 'conversations/visitor-thread/read', 'receipts/delivered', 'conversations/visitor-thread/typing']) {
    const payload = JSON.stringify({ messageIds: [42], text: 'hello' });
    const result = await proxyGuestRequest(request(path, 'POST', { 'Content-Type': 'application/json', Cookie: `wisal_visitor_guest=${token}` }, payload), { backend, fetch: async (url, init) => {
      const upstream = new Request(url, init);
      assert.equal(await upstream.text(), payload);
      assert.equal(upstream.headers.get('cookie'), `wisal_guest=${token}`);
      return Response.json({ error: 'not your conversation' }, { status: 404 });
    } });
    assert.equal(result.status, 404);
  }
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const upload = await proxyGuestRequest(request('uploads?purpose=message&conversationId=visitor-thread', 'POST', { 'content-type': 'image/png', 'x-file-name': 'photo.png' }, bytes), { backend, fetch: async (url, init) => {
    const upstream = new Request(url, init);
    assert.deepEqual(new Uint8Array(await upstream.arrayBuffer()), bytes);
    assert.equal(upstream.headers.get('x-file-name'), 'photo.png');
    return Response.json({ attachment: { id: 'private-photo' } }, { status: 201 });
  } });
  assert.equal(upload.status, 201);
  const media = await proxyGuestRequest(request('attachments/private-photo', 'GET', { Range: 'bytes=0-3' }), { backend, fetch: async (url, init) => {
    assert.equal(init.headers.get('range'), 'bytes=0-3');
    return new Response(bytes, { status: 206, headers: { 'content-range': 'bytes 0-3/8', 'accept-ranges': 'bytes', 'content-type': 'image/png' } });
  } });
  assert.equal(media.status, 206);
  assert.equal(media.headers.get('content-range'), 'bytes 0-3/8');
  assert.deepEqual(new Uint8Array(await media.arrayBuffer()), bytes);
});

test('realtime messages stream immediately without buffering the entire connection', async () => {
  let stream;
  const encoder = new TextEncoder();
  const response = await proxyGuestRequest(request('events?connection=connection-identifier'), { backend, fetch: async () => new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(encoder.encode('retry: 1000\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'retry: 1000\n\n');
  stream.enqueue(encoder.encode('event: messages\ndata: {"messages":[]}\n\n'));
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: messages/);
  stream.close();
  await reader.cancel();
});

test('network failures, redirects, loopback configuration and oversized writes do not leak credentials or turn into open proxying', async () => {
  const bad = await proxyGuestRequest(request('session', 'POST'), { backend, fetch: async () => { throw new Error('private infrastructure secret'); } });
  assert.equal(bad.status, 502);
  assert(!(await bad.text()).includes('secret'));
  assert.equal((await proxyGuestRequest(request('profile'), { backend, fetch: async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }) })).status, 502);
  for (const origin of ['http://owner.example', 'https://secret@owner.example', site, backend + '/api', backend + '?url=elsewhere']) {
    assert.equal((await proxyGuestRequest(request('profile'), { backend: origin })).status, 503);
  }
  assert.equal((await proxyGuestRequest(request('session', 'POST', { 'content-length': '70000' }), { backend })).status, 413);
});
