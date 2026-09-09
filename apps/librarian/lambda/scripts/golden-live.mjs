#!/usr/bin/env node
// Runs the production retrieval golden without reading a local dotenv secret.
// The generated harness credential resolves only in asm-exec's child process.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { goldenRunnerEnvironment } from './golden-live-config.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const stackName = process.env.LIBRARIAN_STACK_NAME || 'weekly-thing-librarian';
const profile = process.env.AWS_PROFILE || 'jamie';
const bundledAsmExec = process.env.CODEX_HOME
  ? join(process.env.CODEX_HOME, 'skills/aws-secrets-manager/references/asm-exec')
  : '';
const asmExec = process.env.ASM_EXEC || (bundledAsmExec && existsSync(bundledAsmExec) ? bundledAsmExec : 'asm-exec');

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

const result = spawnSync(asmExec, [process.execPath, join(scriptDir, 'golden-retrieval.mjs')], {
  env: { ...process.env, AWS_PROFILE: profile, ...goldenRunnerEnvironment(stackOutputs()) },
  stdio: 'inherit'
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
