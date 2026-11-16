import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeImageManagementTab} from './image-management.ts';

test('image management tabs preserve deep links and default safely',()=>{
 assert.equal(normalizeImageManagementTab('images'),'images');
 assert.equal(normalizeImageManagementTab('registry'),'registry');
 assert.equal(normalizeImageManagementTab('sources'),'sources');
 assert.equal(normalizeImageManagementTab(null),'images');
 assert.equal(normalizeImageManagementTab('unknown'),'images');
});
