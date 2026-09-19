import assert from 'node:assert/strict';
import { moveSelection, alignSelection, distributeSelection, selectedItems, activeFootprint } from '../src/components/floorBatch.ts';

const base = {
  gridCols: 14, gridRows: 12,
  tables: [
    { id: 'a', gridX: 1, gridY: 2, spanX: 2, spanY: 2 },
    { id: 'b', gridX: 5, gridY: 5, spanX: 1, spanY: 1 },
    { id: 'c', gridX: 11, gridY: 7, spanX: 2, spanY: 1 }
  ],
  objects: [{ id: 'a', gridX: 6, gridY: 1, spanX: 1, spanY: 1 }]
};
const group = ['table:a', 'table:b', 'table:c'];
assert.equal(selectedItems(base, ['table:a', 'object:a']).length, 2, 'typed ids must not collide');
assert.equal(moveSelection(base, ['table:a'], 1, 2).tables[0].gridX, 2);
assert.equal(moveSelection(base, ['table:c'], 3, 0), null, 'clamp to bounds');
assert.equal(alignSelection(base, group, 'x', 'start').tables[2].gridX, 1);
assert.equal(alignSelection(base, group, 'y', 'center').tables[0].gridY, 4);
assert.deepEqual(distributeSelection(base, group, 'x').tables.map(t => t.gridX), [1, 7, 11]);
assert.equal(distributeSelection(base, group.slice(0, 2), 'x'), null, 'three required');
assert.equal(base.tables[0].gridX, 1, 'immutable snapshots for undo');
const mask = { ...base, gridMask: Array(168).fill(1) };
mask.gridMask[2 * 14 + 2] = 0;
assert.equal(moveSelection(mask, ['table:a'], 1, 0), null, 'active floor mask');
assert.equal(activeFootprint(base, { id: 'outside', gridX: -1, gridY: 0, spanX: 1, spanY: 1 }), false);
console.log('PASS: 10 group geometry assertions');
