import { proxyGuestRequest } from '../../../../lib/guest-proxy.mjs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function route(request: Request) {
  return proxyGuestRequest(request, { backend: process.env.WISAL_BACKEND_URL });
}

export const GET = route;
export const HEAD = route;
export const POST = route;
export const PATCH = route;
