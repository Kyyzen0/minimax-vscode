import * as vscode from 'vscode';
import { MiniMaxApi } from '../api/minimaxClient';
import { error, log } from '../utils/logger';

export function registerCommands(
  context: vscode.ExtensionContext,
  api: MiniMaxApi,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('minimax.login', async () => {
      try {
        await api.signIn();
      } catch (e) {
        error('Login failed', e);
        void vscode.window.showErrorMessage(`MiniMax: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('minimax.logout', async () => {
      try {
        await api.signOut();
      } catch (e) {
        error('Logout failed', e);
        void vscode.window.showErrorMessage(`MiniMax: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('minimax.openChat', async () => {
      await vscode.commands.executeCommand('minimax.chatView.focus');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('minimax.toggleAgentMode', async () => {
      try {
        await api.toggleAgentMode();
        await vscode.commands.executeCommand('minimax.chatView.focus');
      } catch (e) {
        void vscode.window.showErrorMessage(`MiniMax: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('minimax.explain', async () => actionOnSelection(api, 'Explain this snippet')),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('minimax.refactor', async () => actionOnSelection(api, 'Refactor this snippet for clarity and performance')),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('minimax.generateTests', async () => actionOnSelection(api, 'Write thorough unit tests for this snippet')),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('minimax.docs', async () => actionOnSelection(api, 'Add inline documentation and a docstring for this snippet')),
  );
}

async function actionOnSelection(api: MiniMaxApi, instruction: string): Promise<void> {
  const signedIn = await api.isReady();
  if (!signedIn) {
    void vscode.window.showWarningMessage('MiniMax: sign in first.', 'Sign in', 'Cancel').then((choice) => {
      if (choice === 'Sign in') {
        void vscode.commands.executeCommand('minimax.login');
      }
    });
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage('MiniMax: open an editor and select some code.');
    return;
  }
  const selection = editor.document.getText(editor.selection);
  if (!selection || selection.trim().length === 0) {
    void vscode.window.showInformationMessage('MiniMax: select some code to act on.');
    return;
  }
  const consent = await vscode.window.showWarningMessage(
    'The selected code and its file path will be sent to MiniMax Code. Continue?',
    { modal: true },
    'Send selection',
    'Cancel',
  );
  if (consent !== 'Send selection') return;
  const fileName = editor.document.fileName || editor.document.uri.toString();
  const language = editor.document.languageId;
  const userMessage = [
    `Task: ${instruction}.`,
    `Language: ${language}`,
    `File: ${fileName}`,
    'Selected code:',
    '```',
    selection,
    '```',
    'Return ONLY the requested result. Use a fenced code block if you produce code.',
  ].join('\n');

  // Send via chat stream and then show the result in a new Untitled doc.
  await vscode.commands.executeCommand('minimax.openChat');
  // Briefly show a notification that the action ran; the chat panel will have received it
  // through the user's typed instructions. For UX simplicity we also surface the answer here.
  await runAndPresent(api, userMessage, instruction);
}

async function runAndPresent(api: MiniMaxApi, userMessage: string, headline: string): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'MiniMax: ' + headline, cancellable: true },
    async (_progress, token) => {
      const controller = new AbortController();
      const disposable = token.onCancellationRequested(() => controller.abort());
      const buffer: string[] = [];
      try {
        for await (const ev of api.chatStream({
          messages: [{ role: 'user', content: userMessage }],
          signal: controller.signal,
        })) {
          if (ev.type === 'token') {
            buffer.push(ev.delta);
          } else if (ev.type === 'error') {
            void vscode.window.showErrorMessage(`MiniMax: ${ev.message}`);
            return;
          } else if (ev.type === 'done') {
            break;
          }
        }
      } finally {
        disposable.dispose();
      }
      const output = buffer.join('');
      if (output.trim().length > 0) {
        const doc = await vscode.workspace.openTextDocument({
          content: `// ${headline}\n\n${output}`,
        });
        await vscode.window.showTextDocument(doc, { preview: false });
      }
    },
  );
}
