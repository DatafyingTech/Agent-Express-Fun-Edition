import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_NAME, EDITIONS, parseEdition } from '../src/shared/edition.ts';

test('the editions go by their names: Agent Express and Agent Express (Fun Edition)', () => {
  assert.equal(EDITIONS.express.name, 'Agent Express');
  assert.equal(EDITIONS.fun.name, 'Agent Express (Fun Edition)');
  assert.equal(EDITIONS.express.repo, 'DatafyingTech/Agent-Express');
  assert.equal(EDITIONS.fun.repo, 'DatafyingTech/Agent-Express-Fun-Edition');
  assert.equal(EDITIONS.express.has3d, false);
  assert.equal(EDITIONS.fun.has3d, true);
  // The app view is Agent Express in every edition, the Fun Edition's phones included.
  assert.equal(APP_NAME, EDITIONS.express.name);
});

test('an edition is found by its id, its name or the name it had before', () => {
  for (const v of ['express', 'Express', 'agent-express', 'Agent Express', 'hearth', 'Hearth']) assert.equal(parseEdition(v), 'express', v);
  for (const v of ['fun', 'fun-edition', 'agent-express-fun', 'Agent Express (Fun Edition)', 'Agent-Express-Fun-Edition', 'hq', 'HQ', 'hearth-hq', 'Hearth HQ']) {
    assert.equal(parseEdition(v), 'fun', v);
  }
  for (const v of ['office', 'agent-office', 'Agent Office']) assert.equal(parseEdition(v), 'office', v);
  for (const v of ['', undefined, null, 'agent', 'express-fun-x']) assert.equal(parseEdition(v), undefined, String(v));
});
