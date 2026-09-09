#!/usr/bin/env node
// Runs the production retrieval golden without reading a local dotenv secret.
// The generated harness credential resolves only in asm-exec's child process.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asmExecInvocation, goldenRunnerEnvironment, resolveAsmExec } from './golden-live-config.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const stackName = process.env.LIBRARIAN_STACK_NAME || 'weekly-thing-librarian';
const profile = process.env.AWS_PROFILE || 'jamie';
const asmExec = resolveAsmExec({
  asmExec: process.env.ASM_EXEC,
  codexHome: process.env.CODEX_HOME,
  home: process.env.HOME,
  exists: existsSync
});
const [asmCommand, ...asmArgs] = asmExecInvocation(
  join(scriptDir, 'golden-asm-exec.py'),
  Boolean(statSync(join(scriptDir, 'golden-asm-exec.py')).mode & 0o111)
);

if (!existsSync(asmExec)) {
  throw new Error(`asm-exec resolver source is unavailable: ${asmExec}`);
}

function stackOutputs() {
  const response = execFileSync(
    'aws',
    [
      '--profile',
      profile,
      'cloudformation',
      'describe-stacks',
      '--stack-name',
      stackName,
      '--query',
      'Stacks[0].Outputs',
      '--output',
      'json'
    ],
    { encoding: 'utf8' }
  );
  return Object.fromEntries(JSON.parse(response).map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
}

const result = spawnSync(asmCommand, [...asmArgs, process.execPath, join(scriptDir, 'golden-retrieval.mjs')], {
  env: {
    ...process.env,
    ASM_EXEC_SOURCE: asmExec,
    AWS_PROFILE: profile,
    ...goldenRunnerEnvironment(stackOutputs())
  },
  stdio: 'inherit'
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
