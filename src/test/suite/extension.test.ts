//
// Note: This example test is leveraging the Mocha test framework.
// Please refer to their documentation on https://mochajs.org/ for help.
//

// The module 'assert' provides assertion methods from node
import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';

import * as tmp from 'tmp';
import * as fs from 'fs';

export function sleep(ms: number): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}

suite('Woke extension', () => {
	test('Extension should be activated on files', async () => {
		const ext = <vscode.Extension<any>>vscode.extensions.getExtension('get-woke.vscode-woke');
		const filename = tmp.tmpNameSync();
		fs.writeFileSync(filename, "whitelist\n", 'utf8');

		const document = await vscode.workspace.openTextDocument(filename);
		const editor = await vscode.window.showTextDocument(document);
		document.save();

		await sleep(1500);
		const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
		assert.strictEqual(ext.isActive, true, 'Extension should be activated');
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(diagnostics[0].code, 'whitelist');
	});
});
