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
  ['task-complete', /\b(?:task|work|implementation|feature|fix|refactor(?:ing)?|migration|change|changes|pr|pull\s+request|job)s?\s+(?:is|are)\s+(?:now\s+)?(?:complete|completed|done|finished|ready)\b/i],
  ['ready-for', /\bready\s+(?:for|to)\s+(?:review|merge|ship|deploy|release|test(?:ing)?)\b/i],
  ['done', /(?:^|[\s(])(?:all\s+)?done[.!:)]?(?:\s|$)/i],
  ['complete', /^\s*(?:complete|completed|finished|all\s+set|ready)\b/i],
  ['i-have-done', /\b(?:i(?:'ve|\s+have)\s+(?:now\s+|successfully\s+)?)(?:implemented|completed|finished|fixed|resolved|addressed|verified|added|updated|refactored|migrated|wired(?:\s+up)?|integrated|removed|cleaned\s+up)\b/i],
  ['successfully', /\bsuccessfully\s+(?:implemented|fixed|completed|added|updated|migrated|refactored|resolved|built|compiled|passed|verified|tested)\b/i],
  ['verified', /\b(?:verified|confirmed)\s+(?:that\s+)?(?:it|this|the|everything|all)\b/i],
  ['works-now', /\b(?:should\s+(?:now\s+)?work|works\s+(?:now|as\s+expected|correctly|fine)|is\s+(?:now\s+)?working)\b/i],
  ['no-errors', /\b(?:no|zero)\s+(?:more\s+|remaining\s+)?(?:errors|failures|failing\s+tests|type\s+errors|lint\s+errors|issues)\b/i],
];

/** Sentences that look like a claim but are actually about the future or a negation. */
const NEGATIONS: RegExp[] = [
  /\b(?:not\s+yet|haven't|hasn't|isn't|aren't|don't|doesn't|didn't|cannot|can't|couldn't|unable|failed\s+to|still\s+fail|still\s+failing|not\s+(?:yet\s+)?(?:done|complete|passing|working))\b/i,
  /\b(?:i(?:'ll|\s+will)|let\s+me|going\s+to|next\s+(?:step|i)|todo|to\s+do|should\s+i|do\s+you\s+want|would\s+you\s+like|before\s+(?:i|we)\s+(?:can|mark|call))\b/i,
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
