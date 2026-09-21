/**
 * Public surface of the orchestrator.
 *
 * The backend owns research, verification, story and VideoSpec generation.
 * It never renders: GitHub Actions does that (see `.github/workflows`).
 */

export * from './runtime';
export * from './providers/ai';
export * from './providers/search';
export * from './connectors';
export * from './pipeline';
export * from './agents';
export * from './research';
export * from './project';
export * from './dispatch';