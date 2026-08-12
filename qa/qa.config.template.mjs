// Harness standard v1 — QA adapter scaffold for the @braintied/agentic-qa
// engine (live exemplar: Krue/qa/; typed contract: Sentigen-App/qa/types.ts).
// Fill the placeholders, keep every safety rail.
export default {
  app: {
    name: 'watchtower',
    baseUrl: '{{DEV_URL}}',
    // Real login flow captured once via the engine's auth capture; storageState
    // lands in qa/.auth/ (gitignored).
    auth: { kind: 'storage-state', statePath: 'qa/.auth/state.json' },
  },
  observability: {
    // READ-ONLY database checks correlating UI actions with backend truth.
    // Scope every query to the dedicated test workspace — never production data.
    testWorkspaceId: '{{TEST_WORKSPACE_ID}}',
  },
  safety: {
    // Selectors the runner must NEVER click (irreversible/outbound actions).
    neverClickSelectors: ['[data-qa="send"]', '[data-qa="delete"]'],
    preferLocal: true,
    costToleranceUsd: 1.0,
  },
};
