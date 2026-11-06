const DEFAULT_BACKEND = 'https://wisal-direct-20261106.cottonvine2.chatgpt.site';

const jsonError = (status, message) => Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });

function allowed(path, method, url) {
  if (['GET', 'HEAD'].includes(method)) return /^(profile|me|conversations|statuses|events)$/.test(path) || /^conversations\/[a-zA-Z0-9_-]{1,100}\/messages$/.test(path) || /^attachments\/[a-zA-Z0-9_-]{1,100}$/.test(path);
  if (method === 'PATCH') return path === 'me';
  if (method !== 'POST') return false;
  if (/^(session|disconnect|receipts\/delivered)$/.test(path)) return true;
  if (/^conversations\/[a-zA-Z0-9_-]{1,100}\/(messages|read|typing)$/.test(path)) return true;
  return path === 'uploads' && url.searchParams.get('purpose') === 'message' && /^[a-zA-Z0-9_-]{1,100}$/.test(url.searchParams.get('conversationId') || '');
}

/**
 * Same-origin guest gateway. The central backend remains the authority for every thread and file.
 * @param {Request} request
 * @param {{ backend?: string, fetch?: typeof fetch }} [options]
 */
export async function proxyGuestRequest(request, options = {}) {
  const incoming = new URL(request.url), method = request.method.toUpperCase();
  // Next.js can normalize Request.url to localhost; Host still identifies the actual browser origin.
  const host = request.headers.get('host') || incoming.host;
  if (!/^[a-zA-Z0-9.:[\]-]+$/.test(host)) return jsonError(400, 'عنوان الموقع غير صالح.');
  const visitorOrigin = new URL(incoming.protocol + '//' + host).origin;
  let segments;
  try { segments = incoming.pathname.replace(/^\/api\/chat\//, '').split('/').map(decodeURIComponent); }
  catch { return jsonError(400, 'مسار غير صالح.'); }
  if (!incoming.pathname.startsWith('/api/chat/') || segments.some(segment => !segment || segment === '.' || segment === '..' || /[\\/\u0000-\u001f]/.test(segment))) return jsonError(404, 'المسار غير موجود.');
  const path = segments.join('/');
  if (incoming.searchParams.getAll('view').some(view => view !== 'guest') || incoming.searchParams.has('admin') || !allowed(path, method, incoming)) return jsonError(403, 'هذا الرابط مخصص للزوار فقط.');
  if (!['GET', 'HEAD'].includes(method)) {
    if (request.headers.get('x-chat-request') !== '1' || request.headers.get('sec-fetch-site') === 'cross-site' || (request.headers.has('origin') && request.headers.get('origin') !== visitorOrigin)) return jsonError(403, 'مصدر الطلب غير مسموح.');
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > (path === 'uploads' ? 20 * 1024 * 1024 : 64 * 1024)) return jsonError(413, 'حجم الطلب أكبر من المسموح.');
  }
  let backend;
  try {
    backend = new URL(options.backend || DEFAULT_BACKEND);
    if (backend.protocol !== 'https:' || backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash || backend.origin === visitorOrigin || backend.origin === incoming.origin) throw new Error('Invalid backend origin');
  } catch { return jsonError(503, 'إعداد عنوان خادم المحادثات غير صالح.'); }
  const upstream = new URL('/api/chat/' + segments.map(encodeURIComponent).join('/'), backend.origin);
  upstream.search = incoming.search;
  upstream.searchParams.set('view', 'guest');
  const headers = new Headers({ 'X-Chat-Request': '1', Origin: backend.origin, 'User-Agent': 'Mozilla/5.0 (compatible; WisalVisitors/1.0)' });
  for (const key of ['content-type', 'accept', 'x-file-name', 'range', 'if-range', 'if-none-match', 'if-modified-since', 'last-event-id']) {
    const value = request.headers.get(key);
    if (value !== null) headers.set(key, value);
  }
  // No administrator cookies, platform identity headers, authorization or client-supplied backend address.
  const guestCookie = request.headers.get('cookie')?.match(/(?:^|;\s*)wisal_visitor_guest=([a-f0-9]{64})(?:;|$)/);
  if (guestCookie) headers.set('Cookie', 'wisal_guest=' + guestCookie[1]);
  try {
    const init = { method, headers, redirect: 'manual', cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(65000)]) };
    if (!['GET', 'HEAD'].includes(method) && request.body) {
      init.body = request.body;
      init.duplex = 'half';
    }
    const response = await (options.fetch || fetch)(upstream, init);
    if (response.status >= 300 && response.status < 400 && response.status !== 304) return jsonError(502, 'لم يستجب خادم المحادثات بالشكل المتوقع.');
    const resultHeaders = new Headers({ 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' });
    for (const key of ['content-type', 'content-disposition', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'retry-after']) {
      const value = response.headers.get(key);
      if (value !== null) resultHeaders.set(key, value);
    }
    const setCookies = response.headers.getSetCookie();
    for (const cookie of setCookies) {
      const token = cookie.match(/^wisal_guest=([a-f0-9]{64})(?:;|$)/)?.[1];
      if (!token) continue;
      resultHeaders.append('Set-Cookie', `wisal_visitor_guest=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${incoming.protocol === 'https:' ? '; Secure' : ''}`);
    }
    return new Response(method === 'HEAD' || [204, 304].includes(response.status) ? null : response.body, { status: response.status, headers: resultHeaders });
  } catch {
    return jsonError(502, 'تعذّر الوصول إلى خادم المحادثات. حاول مجددًا.');
  }
}
