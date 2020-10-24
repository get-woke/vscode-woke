import * as which from './which';
import * as path from 'path';

export const isWindows = process.platform === 'win32' ||
  process.env.OSTYPE === 'cygwin' ||
  process.env.OSTYPE === 'msys';

export function suffix(): string {
  return isWindows ? ".exe" : "";
}

export function getExecutable(executablePath: string | null): string {
  if (executablePath && !path.isAbsolute(executablePath)) {
    executablePath = which.sync(executablePath, { nothrow: true } as which.Options);
  }

  if (!executablePath) {
    executablePath = `woke${suffix()}`;
  }

  return executablePath;
}
