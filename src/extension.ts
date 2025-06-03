import * as vscode from 'vscode';
import * as path from 'path';

function toKebabCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

async function renameFileToKebab(uri: vscode.Uri) {
  if (!uri) {
    vscode.window.showErrorMessage('No file selected');
    return;
  }
  const oldPath = uri.fsPath;
  const oldName = path.basename(oldPath);
  const dir = path.dirname(oldPath);
  const ext = path.extname(oldName);
  const baseName = oldName.slice(0, -ext.length);

  const kebabName = toKebabCase(baseName) + ext.toLowerCase();

  if (kebabName === oldName) {
    vscode.window.showInformationMessage('Filename is already kebab-case.');
    return;
  }

  const newPath = path.join(dir, kebabName);

  let fileExists = false;
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(newPath));
    fileExists = true;
  } catch {
    fileExists = false;
  }

  if (fileExists) {
    vscode.window.showErrorMessage('A file with the kebab-case name already exists.');
    return;
  }

  try {
    await vscode.workspace.fs.rename(uri, vscode.Uri.file(newPath));
    vscode.window.showInformationMessage(`Renamed to ${kebabName}`);
  } catch (err) {
    vscode.window.showErrorMessage('Failed to rename file: ' + (err as Error).message);
  }
}

async function generateIndexFile(uri: vscode.Uri) {
  if (!uri) {
    vscode.window.showErrorMessage('No folder selected');
    return;
  }
  const folderPath = uri.fsPath;

  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(uri);
  } catch (err) {
    vscode.window.showErrorMessage('Failed to read directory: ' + (err as Error).message);
    return;
  }

  const exportLines: string[] = [];

  for (const [name, type] of entries) {
    if (type === vscode.FileType.File && (name.endsWith('.ts') || name.endsWith('.tsx')) && name !== 'index.ts') {
      const baseName = name.replace(/\.(ts|tsx)$/, '');
      exportLines.push(`export * from './${baseName}';`);
    }
  }

  if (exportLines.length === 0) {
    vscode.window.showInformationMessage('No .ts or .tsx files found to export.');
    return;
  }

  const content = exportLines.join('\n') + '\n';
  const indexUri = vscode.Uri.file(path.join(folderPath, 'index.ts'));

  try {
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(indexUri, encoder.encode(content));
    vscode.window.showInformationMessage('index.ts generated successfully!');
  } catch (err) {
    vscode.window.showErrorMessage('Failed to write index.ts: ' + (err as Error).message);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const renameDisposable = vscode.commands.registerCommand('file-utils.renameFile', renameFileToKebab);
  const exportDisposable = vscode.commands.registerCommand('file-utils.exportIndex', generateIndexFile);

  context.subscriptions.push(renameDisposable, exportDisposable);
}

export function deactivate() {}
