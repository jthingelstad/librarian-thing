import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIBRARIAN_CONTRACT } from '../shared/librarian-contract.mts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultTarget = resolve(root, '../contracts/librarian-api.json');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const targets = args.filter((arg) => arg !== '--check').map((target) => resolve(process.cwd(), target));

let stale = false;
for (const target of targets.length ? targets : [defaultTarget]) {
  const content = `${JSON.stringify(LIBRARIAN_CONTRACT, null, 2)}\n`;
  const checksumTarget = target.replace(/\.json$/, '.sha256');
  const checksum = createHash('sha256').update(content).digest('hex');
  const checksumLine = `${checksum}  ${basename(target)}\n`;
  if (checkOnly) {
    // CI runs --check so a contract source edit that was not re-exported
    // fails the build instead of leaving a silent uncommitted diff.
    const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
    const currentChecksum = existsSync(checksumTarget) ? readFileSync(checksumTarget, 'utf8') : '';
    if (current !== content || currentChecksum !== checksumLine) {
      process.stderr.write(
        `STALE: ${target} does not match shared/librarian-contract.mts - run npm run contract:generate\n`
      );
      stale = true;
    }
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  writeFileSync(checksumTarget, checksumLine);
  process.stdout.write(`${target}\n`);
  process.stdout.write(`${checksumTarget}\n`);
}
if (stale) process.exit(1);
