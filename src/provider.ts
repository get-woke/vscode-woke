import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as semver from 'semver';
import { getToolVersion, tryPromptForUpdatingTool, getExecutable } from './util/tool-check';

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
  private static commandId: string = 'woke.run';
  private diagnosticCollection: vscode.DiagnosticCollection = vscode.languages.createDiagnosticCollection();
  private alternatives = new Map();
  private channel: vscode.OutputChannel;
  private settings!: WokeSettings;
  private executableNotFound: boolean;
  private toolVersion: semver.SemVer | null;
  private documentListener!: vscode.Disposable;

  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

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
      executable: getExecutable(section.get('executablePath')),
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
    return actions;
  }

  private createFix(document: vscode.TextDocument, range: vscode.Range, replacement: string): vscode.CodeAction {
    const msg = `[woke] Click to replace with '${replacement}'`;
    const fix = new vscode.CodeAction(msg, vscode.CodeActionKind.QuickFix);
    fix.edit = new vscode.WorkspaceEdit();
    fix.edit.replace(document.uri, range, replacement);
    return fix;
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
    let diagnostics: vscode.Diagnostic[] = [];
    const docUri = textDocument.uri;

    let fileContent = textDocument.getText();

    if (fileContent !== '') {
      diagnostics = await this.runWoke(fileContent);
    }

    this.diagnosticCollection.set(docUri, diagnostics);
  }

  private async runWoke(source: string): Promise<vscode.Diagnostic[]> {
    return new Promise<vscode.Diagnostic[]>((resolve) => {

      const diagnostics: vscode.Diagnostic[] = [];

      const args = ["--stdin", "-o", "json"];
      args.concat(this.settings.customArgs);

      const options = vscode.workspace.rootPath ? { cwd: vscode.workspace.rootPath } : undefined;

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
          const message = `woke failed.
          Arguments:
          ${args.join('\n')}
          stderr:
          ${stdErrorData}
          `;
          this.showMessage(message, MessageSeverity.error);
        } else {
          const lines = stdOutData.toString().split(/(?:\r\n|\r|\n)/g);
          for (const line of lines) {
            if (line === '') {
              continue;
            }
            let data = JSON.parse(line);

            for (const result of data.Results) {
              let severity: vscode.DiagnosticSeverity = vscode.DiagnosticSeverity.Information;

              let sev = result.Rule.Severity;
              if (sev === "error") {
                severity = vscode.DiagnosticSeverity.Error;
              } else if (sev === "warning") {
                severity = vscode.DiagnosticSeverity.Warning;
              }
              const code = result.Rule.Name;
              // to be referenced later
              this.alternatives.set(code, result.Rule.Alternatives);

              // TODO: error checking
              let line = result.StartPosition.Line;
              let startColumn = result.StartPosition.Column;
              let endColumn = result.EndPosition.Column;
              let reason = result.Reason;

              const range = new vscode.Range(line - 1, startColumn, line - 1, endColumn);
              const diagnostic = new vscode.Diagnostic(range, reason, severity);
              diagnostic.code = code;
              diagnostic.source = "woke";

              diagnostics.push(diagnostic);
            }
          }
        }
        resolve(diagnostics);
      });

      // write into stdin pipe
      try {
        childProcess.stdin.write(source);
        childProcess.stdin.end();
      } catch (error) {
        this.showMessage(`Failed to write to STDIN \nError: ${error.message}`, MessageSeverity.error);
      }
    });
  }
}
