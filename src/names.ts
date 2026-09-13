export const DEFAULT_PROJECT_NAME = 'lark-agent-bot';

/** 从路径里取出最后一段，当作项目名。 */
export function nameFromPath(directory: string): string {
  const base = directory.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  return base === '.' || base === '' ? DEFAULT_PROJECT_NAME : base;
}

/** 工程目录：去掉路径分隔符，中文等原样保留。 */
export function toDirName(projectName: string): string {
  const cleaned = projectName.trim().replace(/[\\/]+/g, '-').replace(/^\.+/, '');
  return cleaned || DEFAULT_PROJECT_NAME;
}

/** package.json name：只留 npm 允许的字符。 */
export function toPackageName(projectName: string): string {
  const slug = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return slug || DEFAULT_PROJECT_NAME;
}
