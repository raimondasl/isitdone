/**
 * Programmatic API. `import { verify, scanIntegrity } from '@aivolution/isitdone'`.
 * The CLI (dist/isitdone.js) is the primary interface; this surface is small and may grow.
 */
export { verify, runIntegrity, timeoutFor, budgetSeconds, receiptSatisfies } from './verify.js';
export type { VerifyOptions, VerifyResult, ResolvedProfile, SkippedCheck } from './verify.js';
export { scanIntegrity, countTests, isTestFile, isTestConfigFile, langOf, formatSummaryLine } from './integrity.js';
export type { Finding, IntegrityReport, IntegritySummary, Severity, Lang, ScanOptions } from './integrity.js';
export { parseUnifiedDiff, collectDiff, readAtBase, readNow } from './diff.js';
export type { DiffFile, DiffLine, Hunk, DiffResult, FileStatus } from './diff.js';
export { detectChecks } from './detect.js';
export type { Check, Detection } from './detect.js';
export { loadConfig } from './config.js';
export type { IsitdoneConfig, CheckConfig, Profile } from './config.js';
export { gitInfo, workingTreeHash, findRoot } from './git.js';
export type { GitInfo } from './git.js';
export { evaluateReceipt, readReceipt, configHash } from './receipt.js';
export type { Receipt, ReceiptEvaluation, ReceiptState } from './receipt.js';
export { runHook, resolveProfile, isContinuation } from './hook.js';
export type { HookOutcome, HookOptions } from './hook.js';
export { HOSTS, getHost, HOST_NAMES } from './hosts.js';
export type { HostAdapter, HostName, HookInput } from './hosts.js';
export { scanHistory, parseSince } from './history.js';
export type { HistoryReport, HistoryOptions, ClaimRecord, Verdict } from './history.js';
export { findClaim } from './claims.js';
export { checkEditedFile, formatEditNote } from './editcheck.js';
export type { EditCheck } from './editcheck.js';
export { toSarif } from './sarif.js';
export { formatReport, formatBlockReason, formatMarkdown, toJson } from './report.js';
export { VERSION } from './version.js';
