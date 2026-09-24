import * as vscode from 'vscode';
import { MiniMaxApi } from './api/minimaxClient';
import { registerChatPanel } from './chat/chatPanel';
import { registerCommands } from './commands/commands';

export function activate(context: vscode.ExtensionContext): void {
  const api = new MiniMaxApi(context);
  registerChatPanel(context, api);
  registerCommands(context, api);
}

export function deactivate(): void {
  // VS Code disposes the subscriptions registered by activate().
}
