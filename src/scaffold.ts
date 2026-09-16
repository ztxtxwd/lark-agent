import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Answers, TemplateChoice } from './types.js';
import { renderEnvFile } from './env-file.js';

const here = dirname(fileURLToPath(import.meta.url));
export const templatesRoot = join(here, '..', 'templates');

export function templateDirFor(kind: TemplateChoice): string {
  return join(templatesRoot, kind);
}

function detectPackageManager(): string {
  const ua = process.env.npm_config_user_agent ?? '';
  if (ua.startsWith('pnpm')) return 'pnpm';
  if (ua.startsWith('yarn')) return 'yarn';
  if (ua.startsWith('bun')) return 'bun';
  return 'npm';
}

async function assertEmptyDir(dest: string): Promise<void> {
  const info = await stat(dest).catch(() => null);
  if (!info) {
    await mkdir(dest, { recursive: true });
    return;
  }
  if (!info.isDirectory()) {
    throw new Error(`目标已存在且不是目录：${dest}`);
  }
  const entries = await readdir(dest);
  if (entries.length > 0) {
    throw new Error(`目标目录不是空的：${dest}`);
  }
}

function skipGenerated(templateDir: string) {
  return (src: string): boolean => {
    const rel = src.startsWith(templateDir) ? src.slice(templateDir.length) : src;
    const parts = rel.split(/[\\/]/).filter(Boolean);
    return !parts.some(
      (p) => p === 'node_modules' || p === 'dist' || p === '.env' || p === 'pnpm-workspace.yaml',
    );
  };
}

export async function copyTemplate(dest: string, answers: Answers): Promise<void> {
  const templateDir = templateDirFor(answers.template);
  const templatePkg = join(templateDir, 'package.json');
  await stat(templatePkg).catch(() => {
    throw new Error(`找不到模板：${templatePkg}`);
  });
  await assertEmptyDir(dest);
  await cp(templateDir, dest, { recursive: true, filter: skipGenerated(templateDir) });

  const pkgPath = join(dest, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { name?: string };
  pkg.name = answers.packageName;
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const readmePath = join(dest, 'README.md');
  const readme = await readFile(readmePath, 'utf8');
  await writeFile(readmePath, readme.replace(/^# .+$/m, `# ${answers.projectName}`));
}

export async function writeEnv(dest: string, answers: Answers): Promise<void> {
  await writeFile(join(dest, '.env'), renderEnvFile(answers), { mode: 0o600 });
}

export function installCommand(): { pm: string; args: string[] } {
  const pm = detectPackageManager();
  if (pm === 'yarn') return { pm, args: [] };
  if (pm === 'bun') return { pm, args: ['install'] };
  return { pm, args: ['install'] };
}

export function runInstall(cwd: string): Promise<void> {
  const { pm, args } = installCommand();
  return spawnOk(pm, args, cwd);
}

export async function tryGitInit(cwd: string): Promise<boolean> {
  try {
    await spawnOk('git', ['init'], cwd, true);
    return true;
  } catch {
    return false;
  }
}

function spawnOk(cmd: string, args: string[], cwd: string, silent = false): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: silent ? 'ignore' : 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}`));
    });
  });
}

export function resolveDest(directory: string): string {
  return resolve(process.cwd(), directory);
}
