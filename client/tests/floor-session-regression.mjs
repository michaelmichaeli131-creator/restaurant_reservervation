import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

// Use production editor functions, not a duplicated model of collision rules.
const source = readFileSync(new URL('../src/components/FloorEditor.tsx', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('  const placementIssue ='), source.indexOf('// Load all layouts'));
assert.ok(code.startsWith('  const placementIssue ='), 'placement validator is present');
const warnings = [];
const table = { id: 'T1', gridX: 1, gridY: 1, spanX: 2, spanY: 2 };
const wall = { id: 'W1', type: 'wall', gridX: 5, gridY: 1, spanX: 2, spanY: 1, kind: 'object' };
const ctx = {
  currentLayout: { gridCols: 10, gridRows: 8, tables: [table], objects: [wall] },
  maskAllows: () => true,
  setPlacementWarning: warning => warnings.push(warning),
  t: (_key, fallback) => fallback,
};
const { placementIssue, checkPlacement } = runInNewContext(
  stripTypeScriptTypes(code) + '\n({ placementIssue, checkPlacement });', ctx,
);
assert.equal(placementIssue(3, 1, 1, 2), '', 'edge adjacency allowed');
assert.match(placementIssue(2, 2, 2, 2), /table/, 'table overlap caught');
assert.match(placementIssue(5, 1, 1, 1), /wall/, 'structural wall overlap caught');
assert.equal(placementIssue(1, 1, 2, 2, { kind: 'table', id: 'T1' }), '', 'own footprint can be edited');
assert.equal(placementIssue(1, 1, 1, 1, { kind: 'object', visualOnly: true }), '', 'decoration can overlay tables');
assert.ok(placementIssue(-1, 1, 1, 1), 'out-of-bounds rejected');
ctx.maskAllows = () => false;
assert.ok(placementIssue(8, 6, 1, 1), 'inactive grid rejected');
ctx.maskAllows = () => true;
assert.equal(checkPlacement(2, 2, 2, 2), false);
assert.match(warnings.at(-1), /table/);
ctx.maskAllows = () => true;
assert.equal(checkPlacement(8, 6, 1, 1), true);
assert.equal(warnings.at(-1), '');

// Verify core history operations use the preceding layout and clear selection.
const historyCode = source.slice(source.indexOf('  const undo ='), source.indexOf('  const [sections,'));
assert.ok(historyCode.includes('const redo ='));
const state = {
  currentLayout: { id: 'floor-1', name: 'new' },
  undoStack: [{ id: 'floor-1', name: 'old' }],
  redoStack: [],
  historyReplay: { current: false },
  setUndoStack: update => { state.undoStack = update(state.undoStack); },
  setRedoStack: update => { state.redoStack = update(state.redoStack); },
  setCurrentLayout: update => { state.currentLayout = update; },
  setSelectedTableId: () => {},
  setSelectedObjectId: () => {},
};
const history = runInNewContext(historyCode + '\n({ undo, redo });', state);
history.undo();
assert.equal(state.currentLayout.name, 'old');
assert.equal(state.redoStack.length, 1);
history.redo();
assert.equal(state.currentLayout.name, 'new');
assert.equal(state.undoStack.length, 1);
console.log('Floor session 1 regression passed: collision, boundaries, decorations, undo and redo.');
