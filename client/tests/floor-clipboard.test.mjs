import assert from 'node:assert/strict';
import { findPastePosition } from '../src/components/floorClipboard.ts';
import { activeFootprint } from '../src/components/floorBatch.ts';

const source = [
  { id: 'a', gridX: 8, gridY: 7, spanX: 2, spanY: 2 },
  { id: 'b', gridX: 11, gridY: 7, spanX: 1, spanY: 1 },
];
const empty = { gridCols: 6, gridRows: 5, tables: [], objects: [] };
const offset = findPastePosition(empty, source);
assert.ok(offset, 'copy fits smaller destination when its group bounds fit');
const moved = source.map(item => ({ ...item, gridX: item.gridX + offset.dx, gridY: item.gridY + offset.dy }));
assert.equal(moved[1].gridX - moved[0].gridX, 3, 'relative spacing preserved');
assert.ok(moved.every(item => activeFootprint(empty, item)), 'all items on destination');
const occupied = { ...empty, tables: [{ id: 'c', gridX: moved[0].gridX, gridY: moved[0].gridY, spanX: 2, spanY: 2 }] };
const offset2 = findPastePosition(occupied, source);
assert.ok(offset2 && (offset2.dx !== offset.dx || offset2.dy !== offset.dy), 'collision finds alternate position');
const mask = { ...empty, gridMask: Array(30).fill(0) };
assert.equal(findPastePosition(mask, source), null, 'inactive destination rejected');
const tooSmall = { ...empty, gridCols: 2 };
assert.equal(findPastePosition(tooSmall, source), null, 'group too wide for destination');
const filled = { ...empty, tables: [{ id: 'all', gridX: 0, gridY: 0, spanX: 6, spanY: 5 }] };
assert.equal(findPastePosition(filled, source), null, 'fully occupied floor rejected');
assert.equal(findPastePosition(empty, []), null, 'empty clipboard safe');
console.log('Clipboard placement regression passed: bounds, relative positions, collisions and mask.');
