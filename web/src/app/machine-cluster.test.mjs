import test from 'node:test';
import assert from 'node:assert/strict';
import {machineClusterMatches,machineClusterOptions} from './machine-cluster.ts';

test('cluster filters distinguish membership and unassigned hosts',()=>{
 const assigned={cluster_id:'prod',cluster_name:'生产集群'},unassigned={};
 assert.equal(machineClusterMatches(assigned,''),true);
 assert.equal(machineClusterMatches(assigned,'prod'),true);
 assert.equal(machineClusterMatches(assigned,'other'),false);
 assert.equal(machineClusterMatches(assigned,'unassigned'),false);
 assert.equal(machineClusterMatches(unassigned,'unassigned'),true);
});

test('cluster options deduplicate, fall back to IDs and include unassigned',()=>{
 assert.deepEqual(machineClusterOptions([{cluster_id:'z',cluster_name:'最后'},{cluster_id:'a'},{cluster_id:'a'}]).map(option=>option.value),['unassigned','a','z']);
});
