import * as vscode from 'vscode';
import { MiniMaxApi, ChatMessage } from '../api/minimaxClient';
import { error, log } from '../utils/logger';

interface StoredMessage extends ChatMessage {
  id: string;
  ts: number;
}

const VIEW_ID = 'minimax.chatView';

export function registerChatPanel(context: vscode.ExtensionContext, api: MiniMaxApi): void {
  const provider = new ChatPanelProvider(context, api);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
}

class ChatPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private history: StoredMessage[] = [];
  private inFlight: AbortController | undefined;
  private cloudDisclosureConfirmed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly api: MiniMaxApi,
  ) {
    // Remove the plaintext history written by pre-0.2.1 versions of this extension.
    void context.workspaceState.update('minimax.history', undefined);
  }

  resolveWebviewView(view: vscode.WebviewView): void | Thenable<void> {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderHtml(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    // Send the initial snapshot.
    void this.postReady();
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = randomNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';`;
    return `<!doctype html><html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>MiniMax Chat</title>
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; }
  #messages { flex: 1; overflow: auto; padding: 12px; }
  .msg { white-space: pre-wrap; line-height: 1.45; padding: 8px 10px; border-radius: 6px; margin: 6px 0; word-break: break-word; }
  .msg.user { background: var(--vscode-input-background); }
  .msg.assistant { background: var(--vscode-editor-background); border-left: 3px solid var(--vscode-textLink-foreground); }
  .msg.system { color: var(--vscode-descriptionForeground); font-style: italic; background: transparent; padding: 4px 0; }
  .msg code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 0 4px; border-radius: 3px; }
  .msg pre { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; overflow: auto; }
  .msg pre code { padding: 0; background: transparent; }
  #input-wrap { padding: 10px; border-top: 1px solid var(--vscode-sideBarSectionHeader-background); background: var(--vscode-sideBar-background); }
  textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 8px; font-family: inherit; resize: vertical; }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .row { display: flex; gap: 8px; margin-top: 8px; align-items: center; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 3px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-input-border); }
  #status { font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: 8px; }
  .thinking { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--vscode-descriptionForeground); border-radius: 50%; border-top-color: transparent; animation: spin 0.8s linear infinite; vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head><body>
<div id="messages"></div>
<div id="input-wrap">
  <textarea id="prompt" placeholder="Ask MiniMax anything. Use Tab/Enter to send. Shift+Enter for newline." rows="3"></textarea>
  <div class="row">
    <button id="send">Send</button>
    <button id="cancel" class="secondary" style="display:none">Cancel</button>
    <button id="clear" class="secondary">Clear</button>
    <button id="agent" class="secondary">Enable agent</button>
    <button id="signin" class="secondary" style="display:none">Sign in</button>
    <span id="status"></span>
  </div>
</div>
<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const promptEl = document.getElementById('prompt');
  const statusEl = document.getElementById('status');
  const sendBtn = document.getElementById('send');
  const cancelBtn = document.getElementById('cancel');
  const clearBtn = document.getElementById('clear');
  const agentBtn = document.getElementById('agent');
  const signinBtn = document.getElementById('signin');

  let currentAssistantId = null;
  let streamingText = '';

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function renderMarkdownLite(text) {
    // very small converter: fenced code blocks, then inline code, then bold/italic
    const parts = [];
    let i = 0;
    const fences = [...text.matchAll(/\`\`\`([\\s\\S]*?)\`\`\`/g)];
    let lastIndex = 0;
    fences.forEach(m => {
      const before = text.slice(lastIndex, m.index);
      parts.push(formatInline(before));
      parts.push('<pre><code>' + escapeHtml(m[1]) + '</code></pre>');
      lastIndex = (m.index ?? 0) + m[0].length;
    });
    parts.push(formatInline(text.slice(lastIndex)));
    return parts.join('');
  }
  function formatInline(s) {
    return escapeHtml(s)
      .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
      .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
      .replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
  }
  function renderMessage(msg) {
    const div = document.createElement('div');
    div.className = 'msg ' + msg.role;
    div.dataset.id = msg.id;
    if (msg.role === 'system') {
      div.textContent = msg.content;
    } else {
      div.innerHTML = renderMarkdownLite(msg.content || '');
    }
    return div;
  }
  function appendMessage(msg) {
    const el = renderMessage(msg);
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }
  function updateLastMessage(id, content) {
    const el = messagesEl.querySelector('.msg[data-id="' + id + '"]');
    if (!el) return;
    el.innerHTML = renderMarkdownLite(content);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });
  sendBtn.addEventListener('click', () => void send());
  cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  clearBtn.addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
  agentBtn.addEventListener('click', () => vscode.postMessage({ type: 'toggleAgent' }));
  signinBtn.addEventListener('click', () => vscode.postMessage({ type: 'signin' }));

  async function send() {
    const text = promptEl.value.trim();
    if (!text) return;
    promptEl.value = '';
    vscode.postMessage({ type: 'send', content: text });
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg) return;
    switch (msg.type) {
      case 'history': {
        messagesEl.innerHTML = '';
        (msg.history || []).forEach(m => appendMessage(m));
        signinBtn.style.display = '';
        agentBtn.textContent = msg.agentMode ? 'Disable agent' : 'Enable agent';
        agentBtn.disabled = !msg.signedIn;
        statusEl.textContent = msg.signedIn
          ? (msg.agentMode ? 'Agent mode: file edits need approval' : 'MiniMax Code available')
          : 'Install MiniMax Code';
        break;
      }
      case 'token': {
        if (currentAssistantId !== msg.id) {
          currentAssistantId = msg.id;
          streamingText = '';
        }
        streamingText += msg.delta;
        updateLastMessage(msg.id, streamingText);
        statusEl.textContent = 'Receiving…';
        break;
      }
      case 'complete': {
        statusEl.textContent = 'Done';
        currentAssistantId = null;
        streamingText = '';
        sendBtn.disabled = false;
        cancelBtn.style.display = 'none';
        break;
      }
      case 'error': {
        appendMessage({ role: 'system', content: 'Error: ' + msg.message, id: 'sys-' + Date.now(), ts: Date.now() });
        statusEl.textContent = 'Error';
        sendBtn.disabled = false;
        cancelBtn.style.display = 'none';
        break;
      }
      case 'busy': {
        sendBtn.disabled = !!msg.busy;
        cancelBtn.style.display = msg.busy ? '' : 'none';
        if (msg.busy) {
          statusEl.innerHTML = 'Thinking <span class="thinking"></span>';
        }
        break;
      }
      case 'cleared': {
        messagesEl.innerHTML = '';
        break;
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body></html>`;
  }

  private async handleMessage(msg: { type: string; content?: string }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.postReady();
        break;
      case 'send':
        await this.handleSend(msg.content ?? '');
        break;
      case 'cancel':
        this.inFlight?.abort();
        this.inFlight = undefined;
        await this.postBusy(false);
        break;
      case 'clear':
        this.history = [];
        this.view?.webview.postMessage({ type: 'cleared' });
        await this.postReady();
        break;
      case 'signin':
        await vscode.commands.executeCommand('minimax.login');
        await this.postReady();
        break;
      case 'toggleAgent':
        try {
          await this.api.toggleAgentMode();
        } catch (e) {
          this.view?.webview.postMessage({
            type: 'error',
            message: e instanceof Error ? e.message : 'Could not change agent mode.',
          });
        }
        await this.postReady();
        break;
      default:
        log(`Unknown message from webview: ${msg.type}`);
    }
  }

  private async postReady(): Promise<void> {
    const signedIn = await this.api.isReady();
    this.view?.webview.postMessage({
      type: 'history',
      history: this.history,
      signedIn,
      agentMode: this.api.isAgentMode(),
    });
  }

  private async postBusy(busy: boolean): Promise<void> {
    this.view?.webview.postMessage({ type: 'busy', busy });
  }

  private async handleSend(prompt: string): Promise<void> {
    if (!prompt) {
      return;
    }
    const signedIn = await this.api.isReady();
    if (!signedIn) {
      this.view?.webview.postMessage({
        type: 'error',
        message: 'Sign in first (click “Sign in” or run MiniMax: Sign in).',
      });
      return;
    }
    if (!this.cloudDisclosureConfirmed) {
      const choice = await vscode.window.showWarningMessage(
        this.api.isAgentMode()
          ? 'Your message will be sent to MiniMax Code. Agent mode may read workspace files; every file change still needs its own diff approval. Chat history stays only in this VS Code session.'
          : 'Your message will be sent to MiniMax Code. Chat history stays only in this VS Code session.',
        { modal: true },
        'Send to MiniMax',
        'Cancel',
      );
      if (choice !== 'Send to MiniMax') return;
      this.cloudDisclosureConfirmed = true;
    }
    const userMsg: StoredMessage = {
      id: 'u-' + Date.now(),
      ts: Date.now(),
      role: 'user',
      content: prompt,
    };
    this.history.push(userMsg);
    const assistantId = 'a-' + Date.now();
    this.history.push({ id: assistantId, ts: Date.now(), role: 'assistant', content: '' });
    await this.postReady();
    await this.postBusy(true);

    // MiniMax Code keeps its own ACP session; send only the new user message.
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

    this.inFlight = new AbortController();
    let aggregated = '';
    try {
      for await (const ev of this.api.chatStream({ messages, signal: this.inFlight.signal })) {
        if (ev.type === 'token') {
          aggregated += ev.delta;
          const last = this.history[this.history.length - 1];
          if (last && last.id === assistantId) {
            last.content = aggregated;
          }
          this.view?.webview.postMessage({ type: 'token', id: assistantId, delta: ev.delta });
        } else if (ev.type === 'error') {
          error(ev.message);
          this.view?.webview.postMessage({ type: 'error', message: ev.message });
          break;
        } else if (ev.type === 'done') {
          break;
        }
      }
    } catch (e) {
      error('Chat stream threw', e);
      this.view?.webview.postMessage({ type: 'error', message: 'MiniMax Code could not complete the request.' });
    } finally {
      this.view?.webview.postMessage({ type: 'complete' });
      await this.postBusy(false);
      this.inFlight = undefined;
    }
  }
}

function randomNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
