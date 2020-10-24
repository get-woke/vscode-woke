/*
The ISC License

Copyright (c) Isaac Z. Schlueter and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
*/

// Typescript port of https://github.com/npm/node-which, including unmerged
// https://github.com/npm/node-which/pull/59

import { isWindows } from './utils';
import { join } from 'path';
const COLON = isWindows ? ';' : ':';
import * as isexe from 'isexe';

export interface Options {
  colon?: string;
  path?: string;
  pathExt?: string;
  // all?: boolean;
  nothrow?: boolean;
}

const getNotFoundError = (cmd: string) =>
  Object.assign(new Error(`not found: ${cmd}`), { code: 'ENOENT' });

const getPathInfo = (cmd: string, opt: Options) => {
  const colon = opt.colon || COLON;

  // If it has a slash, then we don't bother searching the pathenv.
  // just check the file itself, and that's it.
  const pathEnv = cmd.match(/\//) || isWindows && cmd.match(/\\/) ? ['']
    : (
      [
        // windows always checks the cwd first
        ...(isWindows ? [process.cwd()] : []),
        ...(opt.path || process.env.PATH ||
            /* istanbul ignore next: very unusual */ '').split(colon),
      ]
    );
  const pathExtExe = isWindows
    ? opt.pathExt || process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM'
    : '';
  const pathExt = isWindows ? pathExtExe.split(colon) : [''];

  if (isWindows) {
    if (cmd.indexOf('.') !== -1 && pathExt[0] !== '') {
      pathExt.unshift('');
    }

    // Check both upper and lower-case, for case-sensitive directories
    // Unmerged PR https://github.com/npm/node-which/pull/59
    for (var i = 0, l = pathExt.length; i < l; i++) {
      pathExt.push(pathExt[i].toLowerCase());
    }
  }

  return {
    pathEnv,
    pathExt,
    pathExtExe,
  };
};

export function async(cmd: string, opt: Options, cb: Function) {
  const { pathEnv, pathExt, pathExtExe } = getPathInfo(cmd, opt);

  const step = (i: number) => new Promise((resolve, reject) => {
    if (i === pathEnv.length) {
      return reject(getNotFoundError(cmd));
    }

    const ppRaw = pathEnv[i];
    const pathPart = /^".*"$/.test(ppRaw) ? ppRaw.slice(1, -1) : ppRaw;

    const pCmd = join(pathPart, cmd);
    const p = !pathPart && /^\.[\\\/]/.test(cmd) ? cmd.slice(0, 2) + pCmd
      : pCmd;

    resolve(subStep(p, i, 0));
  });

  const subStep = (p: string, i: number, ii: number) => new Promise((resolve, reject) => {
    if (ii === pathExt.length) {
      return resolve(step(i + 1));
    }
    const ext = pathExt[ii];
    isexe(p + ext, { pathExt: pathExtExe }, (er, is) => {
      if (!er && is) {
        return resolve(p + ext);
      }
      return resolve(subStep(p, i, ii + 1));
    });
  });

  return cb ? step(0).then(res => cb(null, res)) : step(0);
};

export function sync(cmd: string, opt: Options): string | null {
  const { pathEnv, pathExt, pathExtExe } = getPathInfo(cmd, opt);

  for (let i = 0; i < pathEnv.length; i++) {
    const ppRaw = pathEnv[i];
    const pathPart = /^".*"$/.test(ppRaw) ? ppRaw.slice(1, -1) : ppRaw;

    const pCmd = join(pathPart, cmd);
    const p = !pathPart && /^\.[\\\/]/.test(cmd) ? cmd.slice(0, 2) + pCmd
      : pCmd;

    for (let j = 0; j < pathExt.length; j++) {
      const cur = p + pathExt[j];
      try {
        const is = isexe.sync(cur, { pathExt: pathExtExe });
        if (is) {
          return cur;
        }
      } catch (ex) { }
    }
  }

  if (opt.nothrow) {
    return null;
  }

  throw getNotFoundError(cmd);
};
