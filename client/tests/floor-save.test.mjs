import assert from 'node:assert/strict';
import { reconcileSavedLayouts } from '../src/components/floorSave.ts';

const layouts = [
  { id: 'a', name: 'Main', isActive: true, tables: [1] },
  { id: 'b', name: 'Terrace', isActive: false, tables: [2] },
];
const saved = { id: 'b', name: 'Terrace updated', isActive: false, tables: [2, 3] };
const failedActivation = reconcileSavedLayouts(layouts, saved, false);
assert.equal(failedActivation[0].isActive, true, 'failed activation preserves real active layout');
assert.equal(failedActivation[1].isActive, false, 'failed activation does not mark saved floor active');
assert.deepEqual(failedActivation[1].tables, [2, 3], 'PUT is still reflected in local layout');
const success = reconcileSavedLayouts(layouts, saved, true);
assert.equal(success[0].isActive, false);
assert.equal(success[1].isActive, true);
assert.equal(layouts[0].isActive, true, 'source state is immutable');
assert.equal(reconcileSavedLayouts(layouts, { ...layouts[0], tables: [5] }, false)[0].isActive, true);
console.log('PASS: save and activation outcomes are reconciled independently.');
