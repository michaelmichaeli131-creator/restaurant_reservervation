import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { canResize } from '../src/components/floorResize.ts';

// Exercise the actual interaction handler without requiring a backend or browser.
const source = readFileSync(new URL('../src/components/FloorEditor.tsx', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('  const beginResizeItem ='), source.indexOf('  // ---- Pointer-based drag'));
function setup(zoom = 1, rotation = 0, direction = 'se') {
  const listeners = new Map();
  const updates = [];
  const cleanup = { current: null };
  const ctx = {
    currentLayout: { gridCols: 12, gridRows: 12, tables: [], objects: [{ id: 'item', rotationDeg: rotation }] },
    cellSize: 60, zoomRef: { current: zoom }, resizeCleanup: cleanup,
    ratioLocked: false, setEditWarning: () => {}, he: false, canResize,
    getItemRotation: x => x, maskAllows: () => true, setResizeDraft: () => {},
    updateTable: (id, value) => updates.push(value), updateObject: (id, value) => updates.push(value),
    window: {
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: name => listeners.delete(name),
    },
  };
  const start = runInNewContext(stripTypeScriptTypes(handler) + '\nbeginResizeItem;', ctx);
  const event = (x, y) => ({ button: 0, pointerId: 3, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} });
  start(event(100, 100), rotation ? 'object' : 'table', 'item', 1, 1, 2, 2, direction);
  return { listeners, updates, event };
}
for (const zoom of [0.5, 1, 2]) {
  const { listeners, updates, event } = setup(zoom);
  for (let i = 1; i <= 20; i++) listeners.get('pointermove')(event(100 + i * 6 * zoom, 100 + i * 3 * zoom));
  listeners.get('pointerup')(event(100 + 120 * zoom, 100 + 60 * zoom));
  assert.equal(updates.length, 1, 'One commit after multiple moves');
  assert.equal(updates[0].spanX, 4);
  assert.equal(updates[0].spanY, 3);
  assert.equal(listeners.size, 0, 'All listeners removed');
}
for (const cancel of ['pointercancel', 'blur', 'keydown']) {
  const { listeners, updates, event } = setup();
  listeners.get('pointermove')(event(220, 220));
  listeners.get(cancel)({ ...event(220, 220), key: 'Escape' });
  assert.equal(updates.length, 0, 'Cancellation does not commit');
  assert.equal(listeners.size, 0);
}
{
  const { listeners, updates, event } = setup();
  listeners.get('pointerup')(event(5000, 5000));
  assert.equal(updates[0].spanX, 11, 'Clamp at map boundary');
}
{
  const { listeners, updates, event } = setup(1, 90);
  listeners.get('pointerup')(event(100, 220));
  assert.equal(updates[0].spanX, 4, 'Rotated object follows local resize axis');
  assert.equal(updates[0].spanY, 2);
}
for (const [direction, delta, expected] of [
  ['nw', [-60, -60], { gridX: 0, gridY: 0, spanX: 3, spanY: 3 }],
  ['w', [-60, 0], { gridX: 0, gridY: 1, spanX: 3, spanY: 2 }],
  ['n', [0, -60], { gridX: 1, gridY: 0, spanX: 2, spanY: 3 }],
  ['e', [60, 0], { gridX: 1, gridY: 1, spanX: 3, spanY: 2 }],
  ['s', [0, 60], { gridX: 1, gridY: 1, spanX: 2, spanY: 3 }],
  ['sw', [-60, 60], { gridX: 0, gridY: 1, spanX: 3, spanY: 3 }],
  ['ne', [60, -60], { gridX: 1, gridY: 0, spanX: 3, spanY: 3 }],
]) {
  const { listeners, updates, event } = setup(1, 0, direction);
  listeners.get('pointerup')(event(100 + delta[0], 100 + delta[1]));
  assert.deepEqual(JSON.parse(JSON.stringify(updates[0])), expected, direction + ' anchor and dimensions');
}
console.log('Resize regression passed: zoom, repeated moves, cancel, boundaries, rotation and seven new directions.');
