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
