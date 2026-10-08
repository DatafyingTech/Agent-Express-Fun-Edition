// Links that have to open on someone else's phone or computer (an invite, "open this on your phone").
// Made in a browser on the office's own machine, at localhost, they'd only ever open there, so they
// use the office's Tailscale address instead, which the server finds at runtime and sends in its
// welcome (server/tailnet.ts). Anywhere else, the address you're on already works.

import { store } from './state';

const LOCALHOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** The origin to put in a link for someone else: the Tailscale address when you're at localhost and the office has one, else your own. */
export function shareOrigin(): string {
  return LOCALHOST.test(location.hostname) && store.share ? store.share : location.origin;
}
