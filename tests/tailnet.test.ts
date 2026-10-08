import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareOrigin, tailnetName } from '../src/server/tailnet.ts';

test("this machine's Tailscale name comes from tailscale status, without the trailing dot", () => {
  const status = (o: object) => JSON.stringify(o);
  assert.equal(tailnetName(status({ BackendState: 'Running', Self: { DNSName: 'office-pc.example-net.ts.net.', Online: true } })), 'office-pc.example-net.ts.net');
  assert.equal(tailnetName(status({ Self: { DNSName: 'Office-PC.example-net.ts.net.' } })), 'office-pc.example-net.ts.net');
  // Signed out, stopped, or not a name at all: no share address.
  assert.equal(tailnetName(status({ BackendState: 'NeedsLogin', Self: { DNSName: 'office-pc.example-net.ts.net.' } })), null);
  assert.equal(tailnetName(status({ BackendState: 'Stopped', Self: { DNSName: '' } })), null);
  assert.equal(tailnetName(status({ BackendState: 'Running', Self: { DNSName: 'evil.ts.net/@x' } })), null);
  assert.equal(tailnetName(status({ BackendState: 'Running' })), null);
  assert.equal(tailnetName('tailscale: not running'), null);
});

test('the share origin carries the port, unless it is the scheme’s own', () => {
  assert.equal(shareOrigin('office-pc.example-net.ts.net', 4600, false), 'http://office-pc.example-net.ts.net:4600');
  assert.equal(shareOrigin('office-pc.example-net.ts.net', 443, true), 'https://office-pc.example-net.ts.net');
  assert.equal(shareOrigin('office-pc.example-net.ts.net', 80, false), 'http://office-pc.example-net.ts.net');
});
