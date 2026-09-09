export function goldenRunnerEnvironment(outputs) {
  const streamUrl = outputs.LibrarianStreamUrl || outputs.LibrarianRawStreamUrl;
  const goldenSecretArn = outputs.LibrarianGoldenRetrieveSecretArn;
  if (!streamUrl) throw new Error('LibrarianStreamUrl stack output is missing');
  if (!goldenSecretArn) throw new Error('LibrarianGoldenRetrieveSecretArn stack output is missing');

  return {
    LIBRARIAN_STREAM_URL: streamUrl,
    LIBRARIAN_RETRIEVE_SECRET: `{{resolve:secretsmanager:${goldenSecretArn}:SecretString:value}}`
  };
}

export function resolveAsmExec({ asmExec, codexHome, home, exists }) {
  if (asmExec) return asmExec;
  const candidates = [
    codexHome && `${codexHome}/skills/aws-secrets-manager/references/asm-exec`,
    home && `${home}/.codex/skills/aws-secrets-manager/references/asm-exec`
  ].filter(Boolean);
  return candidates.find((candidate) => exists(candidate)) || 'asm-exec';
}

export function asmExecInvocation(asmExec, isExecutable) {
  return isExecutable ? [asmExec] : ['python3', asmExec];
}
