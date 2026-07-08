import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesApp, matchingItems, normalizeName } from '../src/matcher';

test('normalizeName strips paths, suffixes, separators', () => {
  assert.equal(normalizeName('Photoshop.exe'), 'photoshop');
  assert.equal(normalizeName('C:\\Program Files\\Adobe\\Photoshop.exe'), 'photoshop');
  assert.equal(normalizeName('/Applications/Slack.app'), 'slack');
  assert.equal(normalizeName('premiere_pro'), 'premiere pro');
});

test('matchesApp: real-world pairs', () => {
  assert.ok(matchesApp('photoshop', 'Adobe Photoshop 2026'));
  assert.ok(matchesApp('photoshop', 'Photoshop.exe'));
  assert.ok(matchesApp('premiere pro', 'Adobe Premiere Pro.exe'));
  assert.ok(matchesApp('figma', 'Figma'));
  assert.ok(matchesApp('figma', 'FigmaAgent'), 'prefix token match');
  assert.ok(matchesApp('powerpoint', 'POWERPNT.EXE') === false, 'abbreviated binaries need the friendly-name trigger'); // documented limitation
  assert.ok(!matchesApp('slack', 'blackslacks'), 'no substring false positives');
  assert.ok(!matchesApp('it', 'iTerm2'), 'short triggers never match');
});

test('matchingItems filters by status and trigger', () => {
  const items = [
    { id: '1', title: 'Export banner', appTrigger: 'photoshop', status: 'active' },
    { id: '2', title: 'Done thing', appTrigger: 'photoshop', status: 'done' },
    { id: '3', title: 'No trigger', appTrigger: null, status: 'active' },
    { id: '4', title: 'Other app', appTrigger: 'figma', status: 'active' },
  ];
  const matched = matchingItems(items, 'Adobe Photoshop 2026');
  assert.deepEqual(
    matched.map((m) => m.id),
    ['1'],
  );
});
