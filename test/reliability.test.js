import test from 'node:test';
import assert from 'node:assert/strict';
import { reliabilityScenarios, runReliabilityScenario } from './reliability/scenarios.js';
for (const scenario of reliabilityScenarios) {
  test(`reliability: ${scenario.title}`, { timeout: 60000 }, async () => {
    const result = await runReliabilityScenario(scenario.id);
    assert.ok(result.passed, `${result.error}\nRetained fixture: ${result.artifactDirectory}`);
  });
}
