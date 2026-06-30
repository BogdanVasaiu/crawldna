// Task classification shared by the orchestrator and the engine.

/**
 * Does the task ask for a software/product DOCUMENTATION site (developer docs, API/SDK
 * reference, guides) — the completeness-first docs path — versus a specific data task
 * (a menu, prices, a list)? This is a deterministic backstop that reads the USER'S
 * INSTRUCTION, never the website, so it stays universal (no per-site rules).
 *
 * It is MULTILINGUAL by design: it matches the documentation STEM rather than one
 * language's spelling, so it works whatever language the task is written in (Latin
 * script). `documenta` covers documentation / documentazione / documentación /
 * documentação / documentatie; `dokumenta` covers German/Nordic (Dokumentation); plus
 * `docs`, `api reference`, and `sdk`. The stem (not a bare "document") avoids false
 * positives on data tasks like "extract the documents list".
 *
 * Why it matters: a true verdict (a) picks the docs profile (llms-full.txt / sitemap →
 * complete, fast) and (b) keeps pages WHOLE (skips the per-section scoping meant for
 * specific tasks). A non-English task wrongly read as "not docs" loses both — it was the
 * bug where an Italian "documentazione" crawl explored blindly and trimmed sections.
 */
export function isDocsTask(task) {
  return /\bdocs?\b|documenta|dokumenta|api[\s_-]*reference|\bsdk\b/i.test(task || '');
}
