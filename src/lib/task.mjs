// Task classification shared by the orchestrator and the engine.

/** Generic "extract the documentation" style task → the model-free docs path. */
export function isDocsTask(task) {
  return /\b(documentation|docs|api\s*reference)\b/i.test(task || '');
}
