import { loadRuntimeSecrets } from '../shared/runtime-secrets.mjs';
import { runSubscribeDigest } from '../shared/subscribe-digest.mjs';
export async function handler() {
  await loadRuntimeSecrets();
  return runSubscribeDigest();
}
