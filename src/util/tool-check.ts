import * as child_process from 'child_process';
import * as semver from 'semver';
import { promisify } from 'util';
import * as vscode from 'vscode';
import * as which from 'which';
import * as path from 'path';

const execFile = promisify(child_process.execFile);

export const BEST_TOOL_VERSION = '0.2.0';

export function tryPromptForUpdatingTool(version: semver.SemVer | null) {
  const disableVersionCheckUpdateSetting = new DisableVersionCheckUpdateSetting();
  if (!disableVersionCheckUpdateSetting.isDisabled) {
    if (!version) {
      promptForUpdatingTool("???", disableVersionCheckUpdateSetting);
    } else if (semver.lt(version, BEST_TOOL_VERSION)) {
      promptForUpdatingTool(version.format(), disableVersionCheckUpdateSetting);
    }
  }
}

export async function getToolVersion(executable: string): Promise<semver.SemVer | null> {
  const { stdout } = await execFile(executable, ["--version"], { timeout: 2000 });
  const matches = /woke version ((?:\d+)\.(?:\d+)(?:\.\d+)*)/.exec(stdout);
  if (matches && matches[1]) {
    return semver.parse(matches[1]);
  }

  return null;
}

async function promptForUpdatingTool(currentVersion: string, disableVersionCheckUpdateSetting: DisableVersionCheckUpdateSetting) {
  const selected = await vscode.window.showInformationMessage(`The vscode-woke extension requires a newer version of "woke" (You got v${currentVersion}, v${BEST_TOOL_VERSION} or better is required)`, 'Don\'t Show Again', 'Update');
  switch (selected) {
    case 'Don\'t Show Again':
      disableVersionCheckUpdateSetting.persist();
      break;
    case 'Update':
      vscode.env.openExternal(vscode.Uri.parse('https://github.com/get-woke/woke#installation'));
      break;
  }
}

export class DisableVersionCheckUpdateSetting {

  private static key = 'disableVersionCheck';
  private config: vscode.WorkspaceConfiguration;
  readonly isDisabled: boolean;

  constructor() {
    this.config = vscode.workspace.getConfiguration('woke', null);
    this.isDisabled = this.config.get(DisableVersionCheckUpdateSetting.key) || false;
  }

  persist() {
    this.config.update(DisableVersionCheckUpdateSetting.key, true, true);
  }
}

export function getExecutable(executablePath: string | undefined): string {
  if (!executablePath) {
    const isWindows = process.platform === 'win32' ||
      process.env.OSTYPE === 'cygwin' ||
      process.env.OSTYPE === 'msys';
    let suffix = '';
    if (isWindows) {
      suffix = '.exe';
    }
    executablePath = `woke${suffix}`;
  }
  if (!path.isAbsolute(executablePath)) {
    executablePath = which.sync(executablePath, { nothrow: true }) || undefined;
  }

  // best guess effort?
  if (!executablePath) {
    executablePath = '/usr/local/bin/woke';
  }

  return executablePath;
}
