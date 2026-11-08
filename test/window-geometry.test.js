import test from 'node:test';
import assert from 'node:assert/strict';
import { fitWindow, resizeWindow } from '../public/window-geometry.js';
const viewport = { width: 1440, height: 1000 };
test('growing into the viewport edge never moves the opposite anchor', () => {
  const start = { x: 848, y: 76, width: 580, height: 904 };
  const resized = resizeWindow(start, 200, 200, 'se', viewport);
  assert.equal(resized.x, start.x);
  assert.equal(resized.y, start.y);
  assert.equal(resized.width, 580);
  assert.equal(resized.height, 912);
});
test('left and top edges preserve the right and bottom edges', () => {
  const start = { x: 848, y: 76, width: 580, height: 904 };
  const resized = resizeWindow(start, -200, -50, 'nw', viewport);
  assert.equal(resized.x, 648);
  assert.equal(resized.y, 26);
  assert.equal(resized.x + resized.width, start.x + start.width);
  assert.equal(resized.y + resized.height, start.y + start.height);
  const minimum = resizeWindow(start, 2000, 2000, 'nw', viewport);
  assert.equal(minimum.width, 340);
  assert.equal(minimum.height, 300);
});
test('saved geometry fits smaller and short viewports without overflow', () => {
  const saved = { x: 1200, y: 800, width: 900, height: 800 };
  const fitted = fitWindow(saved, { width: 800, height: 260 });
  assert.equal(fitted.height, 236);
  assert.equal(fitted.y, 12);
  assert.equal(fitted.x + fitted.width, 788);
});
