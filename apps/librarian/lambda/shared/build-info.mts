/**
 * What this deployment was built from, for /health on both servers.
 *
 * `source_revision` is the stack's NativeBuildId (a digest of the two native
 * bundles and the six corpus object versions), and `corpus_versions` is those
 * object versions in the clear, {"artifacts/<name>": "<VersionId>"}. The sync
 * page (sync.thingelstad.xyz) HEADs each corpus object and compares: a
 * matching version means the running build was deployed against the newest
 * corpus, so what the Librarian holds is what Thingy serves. Both are null
 * where the environment does not carry them (local runs, older stacks).
 */
export function buildInfo(env: NodeJS.ProcessEnv = process.env): {
  source_revision: string | null;
  corpus_versions: Record<string, string> | null;
} {
  return {
    source_revision: env.LIBRARIAN_SOURCE_REVISION || null,
    corpus_versions: corpusVersions(env.LIBRARIAN_CORPUS_VERSIONS)
  };
}

function corpusVersions(raw: string | undefined): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      ([key, value]) => typeof value === 'string' && value && key.startsWith('artifacts/')
    ) as [string, string][];
    return entries.length ? Object.fromEntries(entries) : null;
  } catch {
    return null;
  }
}
