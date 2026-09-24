import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('MiniMax');
  }
  return channel;
}

export function log(message: string, ...rest: unknown[]): void {
  const ch = getChannel();
  const prefix = `[MiniMax] ${message}`;
  if (rest.length === 0) {
    ch.appendLine(prefix);
  } else {
    ch.appendLine(`${prefix} ${rest.map(safeStringify).join(' ')}`);
  }
}

export function error(message: string, err?: unknown): void {
  const ch = getChannel();
  ch.appendLine(`[MiniMax] ERROR ${message}`);
  if (err !== undefined) {
    ch.appendLine(safeStringify(err));
  }
  void vscode.window.showErrorMessage(`MiniMax: ${message}`);
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
