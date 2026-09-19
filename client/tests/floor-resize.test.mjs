import assert from 'node:assert/strict';
import { canResize, resizeByKeyboard } from '../src/components/floorResize.ts';

const item = { gridX: 2, gridY: 2, spanX: 2, spanY: 2 };
assert.deepEqual(resizeByKeyboard(item, 'nw', 1), { gridX: 1, gridY: 1, spanX: 3, spanY: 3 });
assert.deepEqual(resizeByKeyboard(item, 'w', -1), { gridX: 3, gridY: 2, spanX: 1, spanY: 2 });
assert.deepEqual(resizeByKeyboard(item, 's', 1), { gridX: 2, gridY: 2, spanX: 2, spanY: 3 });
assert.deepEqual(resizeByKeyboard(item, 'ne', 1), { gridX: 2, gridY: 1, spanX: 3, spanY: 3 });
assert.deepEqual(resizeByKeyboard(item, 'e', -9), { gridX: 2, gridY: 2, spanX: 1, spanY: 2 });
assert.deepEqual(item, { gridX: 2, gridY: 2, spanX: 2, spanY: 2 }, 'input remains immutable');
const layout = {
  gridCols: 8, gridRows: 8,
  tables: [{ id: 'shared', gridX: 2, gridY: 2, spanX: 2, spanY: 2 }],
  objects: [{ id: 'shared', gridX: 6, gridY: 2, spanX: 1, spanY: 1 }],
};
assert.equal(canResize(layout, 'table', 'shared', { gridX: 2, gridY: 2, spanX: 5, spanY: 2 }), false,
  'same ID across kinds still collides');
assert.equal(canResize(layout, 'table', 'shared', { gridX: 2, gridY: 2, spanX: 3, spanY: 2 }), true);
assert.equal(canResize(layout, 'object', 'shared', { gridX: 2, gridY: 2, spanX: 1, spanY: 1 }), false);
assert.equal(canResize(layout, 'table', 'shared', { gridX: -1, gridY: 2, spanX: 2, spanY: 2 }), false);
const mask = { ...layout, gridMask: Array(64).fill(1) };
mask.gridMask[2 * 8 + 4] = 0;
assert.equal(canResize(mask, 'table', 'shared', { gridX: 2, gridY: 2, spanX: 3, spanY: 2 }), false);
console.log('PASS: keyboard resize directions, collision namespaces, mask and bounds.');
