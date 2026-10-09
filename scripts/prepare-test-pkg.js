import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const INTRANET_NAME = '@tencent/qqbot-nodejs';

const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.name = INTRANET_NAME;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
