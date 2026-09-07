import { describe, expect, it } from 'vitest';
import { findClaim } from '../src/claims.js';

const POSITIVE: Array<[string, string]> = [
  ['Done. All 48 tests pass and the auth refactor is complete.', 'tests-pass'],
  ['All tests are passing now.', 'tests-pass'],
  ['The test suite is green.', 'tests-pass'],
  ['Ran the suite: 112 passed.', 'n-passed'],
  ['Build is green and lint is clean.', 'checks-green'],
  ['Typecheck passes.', 'checks-green'],
  ['Everything passes.', 'everything-passes'],
  ['The implementation is complete.', 'task-complete'],
  ['The fix is done.', 'task-complete'],
  ['Done!', 'done'],
  ['All done.', 'done'],
  ['Complete. The migration script has been added.', 'complete'],
  ["I've implemented the new endpoint and updated the docs.", 'i-have-done'],
  ['I have fixed the race condition in the scheduler.', 'i-have-done'],
  ['Successfully migrated the database schema.', 'successfully'],
  ['I verified that the endpoint returns 200.', 'verified'],
  ['This should now work.', 'works-now'],
  ['The login flow works as expected.', 'works-now'],
  ['No more type errors.', 'no-errors'],
  ['Ready for review.', 'ready-for'],
  // summary at the end of a long message wins
  ['First I looked at the code.\nThen I changed foo.\n\nAll tests pass.', 'tests-pass'],
];

const NEGATIVE: string[] = [
  'The tests are not yet passing; two failures remain in auth.test.ts.',
  "I haven't run the tests yet.",
  'Let me run the tests now.',
  "I'll implement the endpoint next.",
  'Do you want me to also update the docs?',
  'Should I mark this as done?',
  'Here is how the module works: it parses the config and returns a list.',
  'The build is still failing on Windows.',
  'Next step: run the full suite.',
  'What does this function do?',
  'Here is the plan:\n1. Add the migration\n2. Update the model\n3. Run tests',
  '```\nAll tests pass\n```', // inside a code block does not count
  'Tests could not be run because pytest is not installed.',
  '',
];

describe('findClaim', () => {
  it.each(POSITIVE)('detects %j', (text, pattern) => {
    const claim = findClaim(text);
    expect(claim).not.toBeNull();
    expect(claim?.pattern).toBe(pattern);
  });

  it.each(NEGATIVE)('ignores %j', (text) => {
    expect(findClaim(text)).toBeNull();
  });

  it('quotes the matching sentence, trimmed of list markers', () => {
    const claim = findClaim('- Updated the parser\n- All 12 tests pass');
    expect(claim?.sentence).toBe('All 12 tests pass');
  });

  it('truncates very long sentences', () => {
    const claim = findClaim('All tests pass ' + 'x'.repeat(500));
    expect(claim?.sentence.length).toBeLessThanOrEqual(200);
    expect(claim?.sentence.endsWith('...')).toBe(true);
  });

  it('supports custom patterns and ignores invalid regexes', () => {
    expect(findClaim('SHIP IT', ['ship it'])?.pattern).toBe('custom:ship it');
    expect(findClaim('SHIP IT', ['(('])).toBeNull();
  });

  it('handles null and undefined', () => {
    expect(findClaim(null)).toBeNull();
    expect(findClaim(undefined)).toBeNull();
  });
});
