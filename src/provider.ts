import * as vscode from 'vscode';
import * as child_process from 'child_process';

enum MessageSeverity {
  info,
  warning,
  error,
}

export class WokeProvider implements vscode.CodeActionProvider {
  private static commandId: string = 'woke.run';
  private diagnosticCollection: vscode.DiagnosticCollection = vscode.languages.createDiagnosticCollection();
  private alternatives = new Map();
  // TODO
  // private readonly config = vscode.workspace.getConfiguration('woke');

  public activate(subscriptions: vscode.Disposable[]): void {
    subscriptions.push(this);

    vscode.workspace.onDidOpenTextDocument(this.doLint, this, subscriptions);
    vscode.workspace.onDidCloseTextDocument(
      (textDocument) => {
        this.diagnosticCollection.delete(textDocument.uri);
      },
      null,
      subscriptions
    );

    vscode.workspace.onDidSaveTextDocument(this.doLint, this);
    vscode.workspace.textDocuments.forEach(this.doLint, this);

    vscode.commands.registerTextEditorCommand(WokeProvider.commandId, async (editor) => {
      return await this.doLint(editor.document);
    });

  }

  public dispose(): void {
    this.diagnosticCollection.clear();
    this.diagnosticCollection.dispose();
    this.alternatives.clear();
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
    const msg = `[woke] Replace with '${replacement}'`;
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

      // TODO: Allow args from settings
      const args = ["--stdin", "-o", "json"];

      // FIXME: use workspaceFolders instead of rootPath
      const options = vscode.workspace.rootPath ? { cwd: vscode.workspace.rootPath } : undefined;

      // TODO: Ensure this is installed
      const childProcess = child_process.spawn("woke", args, options);
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
              continue
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
              diagnostic.relatedInformation
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
