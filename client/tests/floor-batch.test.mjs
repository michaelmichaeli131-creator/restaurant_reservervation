import assert from 'node:assert/strict';
import { moveSelection, alignSelection, distributeSelection, selectedItems, activeFootprint, selectInRectangle, findCopyOffset, expandGroupSelection } from '../src/components/floorBatch.ts';

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
assert.deepEqual(selectInRectangle(base, 0, 1, 2, 3), ['table:a'], 'select intersecting table');
assert.deepEqual(selectInRectangle(base, 7, 6, 4, 0), ['table:b', 'object:a'], 'reverse rectangle and mixed item types');
assert.deepEqual(selectInRectangle(base, 0, 0, 0, 0), [], 'empty rectangle');
const copy = findCopyOffset(base, ['table:a']);
assert.ok(copy, 'find a nearby valid offset');
const original = base.tables[0];
const moved = { ...original, gridX: original.gridX + copy.dx, gridY: original.gridY + copy.dy };
assert.ok(activeFootprint(base, moved), 'copied footprint stays inside the floor');
assert.ok(base.tables.every(t => moved.gridX + moved.spanX <= t.gridX ||
  t.gridX + t.spanX <= moved.gridX || moved.gridY + moved.spanY <= t.gridY ||
  t.gridY + t.spanY <= moved.gridY), 'copy does not overlap original tables');
const crowded = { gridCols: 2, gridRows: 2, tables: [{ id: 'only', gridX: 0, gridY: 0, spanX: 2, spanY: 2 }], objects: [] };
assert.equal(findCopyOffset(crowded, ['table:only']), null, 'never overlap original or leave bounds');
const masked = { gridCols: 3, gridRows: 2, tables: [{ id: 'one', gridX: 0, gridY: 0, spanX: 1, spanY: 1 }],
  objects: [], gridMask: [1, 0, 0, 0, 0, 0] };
assert.equal(findCopyOffset(masked, ['table:one']), null, 'never duplicate onto inactive mask');
assert.deepEqual(findCopyOffset(base, ['table:missing']), null, 'missing selection is safe');
const linked = { ...base,
  tables: [{ ...base.tables[0], groupId: 'dining-set' }, ...base.tables.slice(1)],
  objects: [{ ...base.objects[0], groupId: 'dining-set' }] };
assert.deepEqual(expandGroupSelection(linked, ['table:a']), ['table:a', 'object:a'], 'selecting table includes linked chair');
assert.deepEqual(expandGroupSelection(linked, ['object:a']), ['object:a', 'table:a'], 'selecting chair includes linked table');
assert.deepEqual(expandGroupSelection(linked, ['table:b']), ['table:b'], 'unlinked item remains independent');
const locked = { ...base, tables: [{ ...base.tables[0], locked: true }, ...base.tables.slice(1)] };
assert.equal(moveSelection(locked, ['table:a'], 1, 0), null, 'locked table cannot move');
assert.equal(alignSelection(locked, ['table:a', 'table:b'], 'x', 'start'), null, 'locked table blocks group alignment');
assert.equal(findCopyOffset(locked, ['table:a']), null, 'locked table cannot be duplicated');
assert.equal(moveSelection(base, ['table:b'], 1, 0).tables[1].gridX, 6, 'unlocked table still moves');
console.log('PASS: 26 group geometry assertions');
