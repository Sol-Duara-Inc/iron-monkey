/**
 * @module iron-monkey
 * Public API surface for the Iron Monkey CDEvents pitching machine library.
 * Re-exports all stable functions, classes, interfaces, and types that external
 * consumers and the CLI entry point can depend on.
 *
 * Typical programmatic usage:
 * ```ts
 * import { runWorkflow } from 'iron-monkey';
 * await runWorkflow('./workflow.yaml', { logLevel: 'info', logFormat: 'text' });
 * ```
 *
 * Individual modules can also be imported directly for more granular control
 * over config loading, manifest building, injection, and bus management.
 */

export { validateWorkflow } from './workflow/parser.js';
export {
  resolveChainTree,
  resolveExpressionTree,
  flattenChains,
  resolveAnchor,
} from './workflow/chain-tree.js';
export { WorkflowSource, FileWorkflowSource } from './workflow/source.js';
export type { WorkflowDefinition } from './workflow/source.js';
export { loadConfig, resolveBusName } from './config/loader.js';
export { loadExpressionRegistry, createRegistry } from './expressions/loader.js';
export { buildManifest } from './manifest/builder.js';
export { parseInjections } from './injection/parser.js';
export { applyInjections } from './injection/apply.js';
export { registerRun, assertRegisterMatchesLocal, ConduitAnsweredError } from './chain/register.js';
export type { RegisterResult, RegisteredChain, ChainIdResult } from './chain/register.js';
export { generateFallbackChainId } from './chain/fallback.js';
export { loadSchemas, validateEvent } from './schema/validator.js';
export {
  loadEventCatalog,
  parseEventCatalog,
  resolveEventType,
  subjectPredicateOfType,
  parseTypeKey,
  compareVersions,
} from './schema/catalog.js';
export type { EventCatalog, ResolvedEventType, TypeKey } from './schema/catalog.js';
export { validateWorkflowDoc } from './workflow/schema.js';
export { validateBundleDoc } from './expressions/schema.js';
export { ExecutionStore, allEvents, INQUIRY_WINDOW_MS } from './execution/store.js';
export type { ExecutionRecord, ExecutionLookup } from './execution/store.js';
export { projectExecution, deriveStatus } from './execution/projection.js';
export type {
  ExecutionInquiryResponse,
  ExecutionEventDetail,
  ExecutionStatus,
} from './execution/projection.js';
export { createBus } from './bus/interface.js';
export { runWorkflow, runWorkflows } from './emitter/runner.js';
export type { WorkflowRunResult } from './emitter/runner.js';
export { loadRepertoire, buildPitchOptions } from './repertoire/loader.js';
export {
  checkNameHints,
  extractHints,
  spellingDiagnostics,
  tokenizeName,
  subjectPredicateOf,
  loadHintTable,
  parseHintTable,
} from './hints/index.js';
export type {
  HintTable,
  HintSubject,
  HintCheckInput,
  HintCheckResult,
  HintViolation,
  HintDiagnostic,
} from './hints/index.js';
export type { RepertoireFile, RepertoirePitch, RepertoireShared } from './repertoire/types.js';
export { createLogger, setLogger, getLogger } from './logger/index.js';

export type {
  WorkflowFile,
  WorkflowDef,
  WorkflowDefaults,
  EventItem,
  ExpressionItem,
  ExpressionOverride,
  ProducesItem,
} from './workflow/types.js';
export type { ResolvedEvent } from './workflow/parser.js';
export type { ResolvedChain, ResolvedChainEvent } from './workflow/chain-tree.js';
export type { ExpressionBundle, ExpressionEvent } from './expressions/types.js';
export type { ExpressionRegistry, HintFinding } from './expressions/loader.js';
export type { IronMonkeyConfig, BusConfig, ToolConfig, ConduitConfig } from './config/types.js';
export type {
  Manifest,
  ManifestEvent,
  DetachedManifestChain,
  CDEventPayload,
} from './manifest/types.js';
export type { Injection } from './injection/parser.js';
