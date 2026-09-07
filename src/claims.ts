/**
 * Conservative detection of "completion claims" in an agent's final message.
 * A match means: the agent is asserting the work is done / tests pass / things are verified.
 * Used only to decide whether to run the expensive (full) profile; never to grade the agent.
 */

export interface Claim {
  sentence: string;
  pattern: string;
}

const CLAIM_PATTERNS: Array<[string, RegExp]> = [
  ['tests-pass', /\b(?:all\s+)?(?:\d+\s+)?(?:unit\s+|integration\s+|e2e\s+|existing\s+|new\s+)?tests?(?:\s+suites?)?\s+(?:are\s+|is\s+|now\s+|still\s+|all\s+|should\s+)*(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?)\b/i],
  ['n-passed', /\b\d+\s+(?:tests?\s+)?pass(?:ed|ing)\b/i],
  ['checks-green', /\b(?:the\s+)?(?:build|typecheck|type\s*check(?:ing)?|lint(?:er|ing)?|ci|pipeline|compil(?:e|ation)|checks?)\s+(?:is\s+|are\s+|now\s+|still\s+|all\s+)*(?:green|pass(?:es|ed|ing)?|clean|succeed(?:s|ed)?|successful)\b/i],
  ['everything-passes', /\b(?:everything|all\s+checks|all\s+of\s+the\s+above|the\s+suite)\s+(?:is\s+|are\s+|now\s+)*(?:pass(?:es|ing)?|green|working|good|clean)\b/i],
  ['all-green', /\b(?:all\s+green|good\s+to\s+go|green\s+across\s+the\s+board)\b/i],
  ['task-complete', /\b(?:task|work|implementation|feature|fix|refactor(?:ing)?|migration|change|changes|pr|pull\s+request|job|everything)s?\s+(?:is|are|has\s+been|have\s+been)\s+(?:now\s+)?(?:complete|completed|done|finished|ready|implemented|wrapped\s+up)\b/i],
  ['ready-for', /\bready\s+(?:for|to)\s+(?:review|merge|ship|deploy|release|test(?:ing)?|use)\b/i],
  ['done', /(?:^|[\s(])(?:all\s+)?done[.!:)]?(?:\s|$)/i],
  ['complete', /^\s*(?:complete|completed|finished|all\s+set|ready|that's\s+it|wrapped\s+up)\b/i],
  ['i-have-done', /\b(?:i(?:'ve|\s+have)\s+(?:now\s+|successfully\s+|also\s+)?)(?:implemented|completed|finished|fixed|resolved|addressed|verified|added|updated|refactored|migrated|wired(?:\s+up)?|integrated|removed|cleaned\s+up|written|created|built)\b/i],
  ['past-tense-summary', /^\s*(?:implemented|fixed|added|updated|refactored|migrated|completed|finished|resolved|removed|created|built)\b\s+(?:the|a|an|all|your|this|that|support|tests?|new)\b/i],
  ['successfully', /\bsuccessfully\s+(?:implemented|fixed|completed|added|updated|migrated|refactored|resolved|built|compiled|passed|verified|tested)\b/i],
  ['verified', /\b(?:verified|confirmed|double[-\s]checked)\s+(?:that\s+)?(?:it|this|the|everything|all|they)\b/i],
  ['works-now', /\b(?:should\s+(?:now\s+)?work|works\s+(?:now|as\s+expected|correctly|fine|end[-\s]to[-\s]end)|is\s+(?:now\s+)?working|are\s+(?:now\s+)?working|now\s+works)\b/i],
  ['no-errors', /\b(?:no|zero)\s+(?:more\s+|remaining\s+|new\s+)?(?:errors|failures|failing\s+tests|type\s+errors|lint\s+errors|issues|warnings)\b/i],
  ['passes-now', /\b(?:now\s+pass(?:es|ing)?|pass(?:es|ing)?\s+(?:now|locally|cleanly))\b/i],
];

/** Sentences that look like a claim but are actually about the future or a negation. */
const NEGATIONS: RegExp[] = [
  /\b(?:not\s+yet|haven't|hasn't|isn't|aren't|don't|doesn't|didn't|cannot|can't|couldn't|won't|wouldn't|unable|have\s+not|has\s+not|is\s+not|are\s+not|do\s+not|does\s+not|did\s+not|will\s+not|could\s+not|failed\s+to|still\s+fail|still\s+failing|not\s+(?:yet\s+)?(?:done|complete|passing|working|verified)|no\s+longer)\b/i,
  /\b(?:i(?:'ll|\s+will)|let\s+me|going\s+to|next\s+(?:step|i|up)|todo|to\s+do|should\s+i|do\s+you\s+want|would\s+you\s+like|before\s+(?:i|we)\s+(?:can|mark|call)|once\s+you|if\s+you\s+want|remaining\s+work|still\s+(?:need|needs|to\s+do|todo))\b/i,
  /\?\s*$/,
];

function splitSentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, ' ') // ignore code blocks
    .replace(/`[^`\n]*`/g, ' ') // ignore inline code
    .split(/(?<=[.!?])\s+|\n+|(?<=:)\s+(?=[A-Z])/)
    .map((s) => s.replace(/^[\s\-*#>•\d.)]+/, '').trim())
    .filter((s) => s.length > 0);
}

export function findClaim(text: string | undefined | null, extraPatterns: string[] = []): Claim | null {
  if (!text) return null;
  const extras: Array<[string, RegExp]> = [];
  for (const p of extraPatterns) {
    try {
      extras.push([`custom:${p}`, new RegExp(p, 'i')]);
    } catch {
      // ignore invalid user regex
    }
  }
  const patterns = [...CLAIM_PATTERNS, ...extras];
  // Prefer later sentences: agents summarise at the end.
  const sentences = splitSentences(text).reverse();
  for (const sentence of sentences) {
    if (NEGATIONS.some((n) => n.test(sentence))) continue;
    for (const [name, re] of patterns) {
      if (re.test(sentence)) {
        return { sentence: sentence.length > 200 ? sentence.slice(0, 197) + '...' : sentence, pattern: name };
      }
    }
  }
  return null;
}
