import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './test-module.mjs';
const {toPixels,snapGrid,previewLayout,overlaps}=loadSource(new URL('./layout.ts',import.meta.url));
const a={id:'A',x:0,y:0,w:6,h:5,minH:5},b={id:'B',x:6,y:0,w:6,h:5,minH:5},c={id:'C',x:6,y:5,w:6,h:5,minH:5};
test('pixel/grid conversion keeps saved layout at desktop and 751px widths',()=>{for(const width of [1368,719]){assert.deepEqual(snapGrid(toPixels(a,width),a,width,'move'),{x:0,y:0,w:6,h:5});assert.deepEqual(snapGrid(toPixels(a,width),a,width,'resize'),{x:0,y:0,w:6,h:5});}});
test('free pointer movement snaps only its ghost and respects panel minimums and API size bounds',()=>{assert.deepEqual(snapGrid({x:4000,y:-100,width:10,height:20},a,719,'move'),{x:6,y:0,w:6,h:5});assert.deepEqual(snapGrid({x:0,y:0,width:5,height:5},a,719,'resize'),{x:0,y:0,w:2,h:5});assert.deepEqual(snapGrid({x:0,y:0,width:4000,height:4000},a,719,'resize'),{x:0,y:0,w:12,h:40});});
test('insertion previews a deterministic collision chain without compacting unrelated panels',()=>{const untouched={id:'D',x:0,y:20,w:6,h:5,minH:5},source=[a,b,c,untouched],target={x:6,y:0,w:6,h:5},first=previewLayout(source,'A',target);assert.deepEqual(first.items.map(item=>item.y),[0,5,10,20]);assert.deepEqual(first.displaced,['B','C']);assert.equal(source[1].y,0);assert.deepEqual(previewLayout(source,'A',target),first);for(const [index,item] of first.items.entries())for(const other of first.items.slice(index+1))assert.equal(overlaps(item,other),false);});
