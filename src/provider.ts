import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as semver from 'semver';
import { getToolVersion, tryPromptForUpdatingTool } from './util/tool-check';
import { getExecutable } from './util/utils';

enum MessageSeverity {
  info,
  warning,
  error,
}

interface WokeSettings {
  enabled: boolean;
  executable: string;
  trigger: RunTrigger;
  customArgs: string[];
}

enum RunTrigger {
  onSave,
  onType,
  manual,
}

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace RunTrigger {
  export const strings = {
    onSave: 'onSave',
    onType: 'onType',
    manual: 'manual',
  };

  export function from(value: string): RunTrigger {
    switch (value) {
      case strings.onSave:
        return RunTrigger.onSave;
      case strings.onType:
        return RunTrigger.onType;
      default:
        return RunTrigger.manual;
    }
  }
}

export class WokeProvider implements vscode.CodeActionProvider {
  private static commandId = 'woke.run';
  private diagnosticCollection: vscode.DiagnosticCollection = vscode.languages.createDiagnosticCollection();
  private alternatives = new Map();
  private channel: vscode.OutputChannel;
  private settings!: WokeSettings;
  private executableNotFound: boolean;
  private toolVersion: semver.SemVer | null;
  private documentListener!: vscode.Disposable;

  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  private static fileArgs: string[] = ['-o', 'json'];
  private static bufferArgs: string[] = ['--stdin', '-o', 'json'];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.channel = vscode.window.createOutputChannel('woke');
    this.executableNotFound = false;
    this.toolVersion = null;

    // code actions
    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider('woke', this, {
        providedCodeActionKinds: WokeProvider.providedCodeActionKinds,
      }),
    );

    // commands
    context.subscriptions.push(
      vscode.commands.registerTextEditorCommand(WokeProvider.commandId, async (editor) => {
        return await this.doLint(editor.document);
      }),
    );

    // event handlers
    vscode.workspace.onDidChangeConfiguration(this.loadConfiguration, this, context.subscriptions);
    vscode.workspace.onDidOpenTextDocument(this.doLint, this, context.subscriptions);

    // populate this.settings
    this.loadConfiguration().then(() => {
      // woke all open documents
      vscode.workspace.textDocuments.forEach(this.doLint, this);
    });
  }

  public dispose(): void {
    if (this.documentListener) {
      this.documentListener.dispose();
    }
    this.diagnosticCollection.clear();
    this.diagnosticCollection.dispose();
    this.channel.dispose();
    this.alternatives.clear();
  }

  private async loadConfiguration() {
    const section = vscode.workspace.getConfiguration('woke', null);
    const settings = <WokeSettings>{
      enabled: section.get('enable', true),
      trigger: RunTrigger.from(section.get('run', RunTrigger.strings.onSave)),
      executable: getExecutable(section.get('executablePath', null)),
      customArgs: section.get('customArgs', []),
    };
    this.settings = settings;

    this.diagnosticCollection.clear();

    if (settings.enabled) {
      if (settings.trigger === RunTrigger.onType) {
        this.documentListener = vscode.workspace.onDidChangeTextDocument((e) => {
          this.doLint(e.document);
        }, this, this.context.subscriptions);
      } else if (settings.trigger === RunTrigger.onSave) {
        this.documentListener = vscode.workspace.onDidSaveTextDocument(this.doLint, this, this.context.subscriptions);
      }

      // Prompt user to update Woke binary when necessary
      try {
        this.toolVersion = await getToolVersion(settings.executable);
        this.executableNotFound = false;
      } catch (error) {
        this.showMessage(error, MessageSeverity.error);
        this.executableNotFound = true;
      }
      this.channel.appendLine(`[INFO] woke version: ${this.toolVersion}`);
      tryPromptForUpdatingTool(this.toolVersion);
    }

    // Configuration has changed. Re-evaluate all documents
    vscode.workspace.textDocuments.forEach(this.doLint, this);
  }

  provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]> {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      this.alternatives.get(diagnostic.code).forEach((alt: string) => {
        actions.push(this.createFix(document, diagnostic.range, alt));
      });
    }
    for (const diagnostic of context.diagnostics) {
      this.alternatives.get(diagnostic.code).forEach((alt: string) => {
        const action = this.createFixAll(document, diagnostic.code, alt);
        if (action !== undefined) {
          actions.push(action);
        }
      });
    }
    return actions;
  }

  private capitalizeReplacementIfNeeded(document: vscode.TextDocument, range: vscode.Range, replacement: string): string {
    const text = document.getText(range);
    let caseAwareReplacement: string = replacement;
    if (text.length > 0) {
      const firstCharacter = text[0];
      if (firstCharacter === firstCharacter.toUpperCase()) {
        caseAwareReplacement = replacement[0].toUpperCase();
        if (replacement.length > 1) {
          caseAwareReplacement += replacement.substring(1);
        }
      }
    }
    return caseAwareReplacement;
  }

  private getFixEdit(msg: string): vscode.CodeAction {
    const fix: vscode.CodeAction = new vscode.CodeAction(msg, vscode.CodeActionKind.QuickFix);
    fix.edit = new vscode.WorkspaceEdit();
    return fix;
  }

  private createFix(document: vscode.TextDocument, range: vscode.Range, replacement: string): vscode.CodeAction {
    const capitalizedReplacement = this.capitalizeReplacementIfNeeded(document, range, replacement);
    const msg = `[woke] Click to replace with '${capitalizedReplacement}'`;
    const fix = this.getFixEdit(msg);
    fix?.edit?.replace(document.uri, range, capitalizedReplacement);
    return fix;
  }

  private createFixAll(document: vscode.TextDocument, code: any, replacement: string): vscode.CodeAction | undefined{
    const textEdits = new Array<vscode.TextEdit>();
    const diagnosticCollection = this.diagnosticCollection.get(document.uri);
    if (diagnosticCollection !== undefined) {
      for (const diagnostic of diagnosticCollection) {
        if (diagnostic.code === code) {
          const capitalizedReplacement = this.capitalizeReplacementIfNeeded(document, diagnostic.range, replacement);
          textEdits.push(new vscode.TextEdit(diagnostic.range, capitalizedReplacement));
        }
      }

      if (textEdits.length > 1) {
        const fix = this.getFixEdit(`[woke] Click to replace ALL with '${replacement}'`);
        fix?.edit?.set(document.uri, textEdits);
        return fix;
      }
    }

    return undefined;
  }

  private showMessage(msg: string, severity: MessageSeverity): void {
    const showMsg = `Woke: ${msg}`;

    switch (severity) {
      case MessageSeverity.info:
        vscode.window.showInformationMessage(showMsg);
        break;
      case MessageSeverity.warning:
        vscode.window.showWarningMessage(showMsg);
        break;
      case MessageSeverity.error:
        vscode.window.showErrorMessage(showMsg);
    }
  }

  private async doLint(textDocument: vscode.TextDocument): Promise<void> {
    const docUri = textDocument.uri;
    const diagnostics: vscode.Diagnostic[] = await this.runWoke(textDocument);

    this.diagnosticCollection.set(docUri, diagnostics);
  }

  private async runWoke(textDocument: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
    return new Promise<vscode.Diagnostic[]>((resolve) => {
      const diagnostics: vscode.Diagnostic[] = [];
      const useBufferArgs = textDocument.isUntitled || this.settings.trigger !== RunTrigger.onSave;

      const processLine = (item: string) => {
        if (item === '' || item.startsWith("No violations found")) {
          return;
        }
        diagnostics.push(...this.asDiagnostic(item));
      };

      const options = vscode.workspace.rootPath ? { cwd: vscode.workspace.rootPath } : undefined;
      let args: string[] = [];
      args.concat(this.settings.customArgs);

      if (useBufferArgs) {
        args = WokeProvider.bufferArgs;
      } else {
        args = WokeProvider.fileArgs.slice(0);
        args.push(textDocument.fileName);
      }

      const childProcess = child_process.spawn(this.settings.executable, args, options);
      childProcess.on('error', (error: Error) => {
        if (error) {
          this.showMessage(`Failed to spawn 'woke' binary. \nError: ${error.message}`, MessageSeverity.error);
          resolve(diagnostics);
        }
      });

      let stdErrorData = '';
      let stdOutData = '';
      childProcess.stderr.on('data', (chunk) => {
        stdErrorData += chunk;
      });
      childProcess.stdout.on('data', (chunk) => {
        stdOutData += chunk;
      });
      childProcess.on('close', (exitCode) => {
        if (exitCode !== 0) {
          // general error when woke failed
          const message = `${this.settings.executable} failed.
          Arguments:
          ${args.join('\n')}
          stderr:
          ${stdErrorData}
          `;
          this.showMessage(message, MessageSeverity.error);
        } else {
          stdOutData.toString().split(/(?:\r\n|\r|\n)/g).forEach(processLine);
        }

        resolve(diagnostics);
      });

      if (useBufferArgs) {
        // write into stdin pipe
        try {
          childProcess.stdin.write(textDocument.getText());
          childProcess.stdin.end();
        } catch (error) {
          this.showMessage(`Failed to write to STDIN \nError: ${error.message}`, MessageSeverity.error);
        }
      }
    });
  }

  private asDiagnostic(line: string): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    let data;
    try {
      data = JSON.parse(line);
    } catch (e) {
      console.warn(`error parsing json: ${e}`);
      return diagnostics;
    }

    for (const result of data.Results) {
      let severity: vscode.DiagnosticSeverity = vscode.DiagnosticSeverity.Information;

      if (result.Rule.Severity === "error") {
        severity = vscode.DiagnosticSeverity.Error;
      } else if (result.Rule.Severity === "warning") {
        severity = vscode.DiagnosticSeverity.Warning;
      }
      const code = result.Rule.Name;
      // to be referenced later
      this.alternatives.set(code, result.Rule.Alternatives);

      // TODO: error checking
      const line = result.StartPosition.Line;
      const startColumn = result.StartPosition.Column;
      const endColumn = result.EndPosition.Column;
      const reason = result.Reason;

      const range = new vscode.Range(line - 1, startColumn, line - 1, endColumn);
      const diagnostic = new vscode.Diagnostic(range, reason, severity);
      diagnostic.code = code;
      diagnostic.source = "woke";

      diagnostics.push(diagnostic);
    }
    return diagnostics;
  }
}
