import * as vscode from 'vscode';

import { WokeProvider } from './provider';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext): void {
	const wokeDiagnostics = vscode.languages.createDiagnosticCollection("woke");
	context.subscriptions.push(wokeDiagnostics);
	const linter = new WokeProvider(context);
	vscode.languages.registerCodeActionsProvider({scheme: 'file'}, linter);
}

// this method is called when your extension is deactivated
export function deactivate(): void {
	// do nothing here
}
