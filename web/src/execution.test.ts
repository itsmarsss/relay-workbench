import test from 'node:test';
import assert from 'node:assert/strict';
import { executionLayout } from './execution.ts';
test('execution edges retain diagnostic parents and checkpoint branches',()=>{
  const graph=executionLayout({attempts:[
    {id:'a',stage:'implement',startedAt:'2026-01-01T01:00Z'},
    {id:'v',stage:'verify',startedAt:'2026-01-01T02:00Z'},
    {id:'d',stage:'verify',role:'debug',parentAttemptId:'a',startedAt:'2026-01-01T03:00Z'},
    {id:'r',stage:'implement',startedAt:'2026-01-01T04:00Z'},
  ],deliveryRuns:[{id:'p',stage:'publish',auxiliary:true,startedAt:'2026-01-01T05:00Z'},{id:'m',stage:'monitor'}]},
  {checkpoints:[{id:'c',attemptId:'v',summary:'Saved'}],forks:[{taskId:'new',attemptId:'v',title:'Alternate approach',status:'paused'}]});
  assert.deepEqual(graph.edges.find(e=>e.to==='d'),{from:'a',to:'d',label:'Diagnose',branch:true});
  assert.equal(graph.edges.find(e=>e.to==='r')?.label,'Continue');
  assert.equal(graph.byId.get('v')?.checkpoints[0]?.id,'c');
  assert.equal(graph.edges.find(e=>e.to==='fork-new')?.from,'v');
  assert.ok(!graph.byId.has('m'));
  assert.equal(new Set(graph.nodes.map(n=>`${n.x}:${n.y}`)).size,graph.nodes.length);
});
test('execution layout tolerates missing parents and duplicate history',()=>{
 const g=executionLayout({attempts:[{id:'a',parentAttemptId:'missing'},{id:'a'},{id:'b',parentAttemptId:'b'}]});
 assert.equal(g.nodes.length,2);assert.equal(g.edges[0]?.from,'a');
});
