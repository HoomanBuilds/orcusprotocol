import assert from "node:assert/strict";

export function assertSuccessfulComputeFinal(result: { requiresClarification?: boolean; message?: { content?: string; toolSteps?: Array<{ name: string; ok: boolean }> } }, tool: string, expectedText: RegExp[] = []) {
  assert.equal(result.requiresClarification, false, `${tool} produced no usable grounded final answer`);
  const content = result.message?.content;
  assert.ok(typeof content === "string" && content.trim(), `${tool} returned an empty final answer`);
  assert.doesNotMatch(content, /I could not verify the sources|I do not have a successful market or research observation|reached this run's time or inference budget|authorized operating budget cannot fund/i, `${tool} returned a blocked final answer`);
  assert.ok(result.message?.toolSteps?.some(step => step.name === tool && step.ok), `${tool} did not complete successfully`);
  for (const expected of expectedText) assert.match(content, expected, `${tool} final answer omitted its expected result`);
}
