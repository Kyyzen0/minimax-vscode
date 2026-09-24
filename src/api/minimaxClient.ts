import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { error, log } from '../utils/logger';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  signal?: AbortSignal;
}

export interface CompletionRequest {
  prompt: string;
  suffix?: string;
  maxTokens?: number;
  temperature?: number;
  language?: string;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'token'; delta: string }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; message: string };

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/**
 * ACP client for the official MiniMax Code CLI. `mcode login` owns the browser
 * sign-in and credential storage; this extension never reads a MiniMax token.
 */
export class MiniMaxApi implements vscode.Disposable {
  private process: childProcess.ChildProcessWithoutNullStreams | undefined;
  private sessionId: string | undefined;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private activeTurn:
    | { push: (event: StreamEvent) => void; done: () => void; fail: (reason: Error) => void }
    | undefined;
  private startPromise: Promise<void> | undefined;
  private commandAvailable: boolean | undefined;
  private executable: string | undefined;
  // Deliberately session-only: agent access is never remembered for a folder.
  private agentMode = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(this);
  }

  /** True when the official MiniMax Code CLI is available in a trusted workspace. */
  async isReady(): Promise<boolean> {
    if (this.commandAvailable !== undefined) return this.commandAvailable;
    if (!vscode.workspace.isTrusted) {
      this.commandAvailable = false;
      return false;
    }
    for (const candidate of mcodeCandidates()) {
      try {
        await execFile(candidate, ['--version']);
        this.executable = candidate;
        this.commandAvailable = true;
        return true;
      } catch {
        // Try the next trusted, user-controlled installation location.
      }
    }
    this.commandAvailable = false;
    return false;
  }

  /** Opens an integrated terminal; MiniMax Code performs the browser OAuth flow. */
  async signIn(): Promise<void> {
    if (!(await this.isReady())) {
      throw new Error('Trust this workspace and install MiniMax Code before signing in.');
    }
    const executable = await this.mcodeExecutable();
    const terminal = vscode.window.createTerminal({
      name: 'MiniMax sign in',
      shellPath: executable,
      shellArgs: ['login', '--region', region()],
      cwd: workspaceFolder(),
    });
    terminal.show(true);
    void vscode.window.showInformationMessage('Finish the MiniMax sign-in in the browser opened by MiniMax Code, then return to VS Code.');
  }

  /** Lets MiniMax Code, not this extension, clear its own sign-in state. */
  async signOut(): Promise<void> {
    if (!(await this.isReady())) return;
    const executable = await this.mcodeExecutable();
    const terminal = vscode.window.createTerminal({
      name: 'MiniMax sign out',
      shellPath: executable,
      shellArgs: ['logout'],
      cwd: workspaceFolder(),
    });
    terminal.show(true);
  }

  isAgentMode(): boolean {
    return this.agentMode;
  }

  /** Enables guarded ACP file access for the current VS Code session only. */
  async toggleAgentMode(): Promise<boolean> {
    if (this.agentMode) {
      this.agentMode = false;
      void vscode.window.showInformationMessage('MiniMax agent mode is off. File requests will now be declined.');
      return false;
    }
    if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.length) {
      throw new Error('Trust and open a folder before enabling agent mode.');
    }
    const choice = await vscode.window.showWarningMessage(
      'Agent mode lets MiniMax read files inside the open workspace. Every proposed file change opens a diff and needs your approval. Terminal, Git and GitHub actions stay blocked.',
      { modal: true },
      'Enable agent mode',
      'Cancel',
    );
    if (choice !== 'Enable agent mode') return false;
    this.agentMode = true;
    return true;
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    if (!vscode.workspace.isTrusted) {
      yield { type: 'error', message: 'Trust this workspace before using MiniMax.' };
      return;
    }
    if (!(await this.isReady())) {
      yield { type: 'error', message: 'MiniMax Code is not installed. Install it, then use “MiniMax: Sign in”.' };
      return;
    }
    if (this.activeTurn) {
      yield { type: 'error', message: 'A MiniMax request is already running.' };
      return;
    }

    const queue = new AsyncEventQueue<StreamEvent>();
    this.activeTurn = { push: (event) => queue.push(event), done: () => queue.end(), fail: (reason) => queue.fail(reason) };
    const abort = () => {
      if (this.sessionId) this.notify('session/cancel', { sessionId: this.sessionId });
    };
    req.signal?.addEventListener('abort', abort, { once: true });

    try {
      await this.start();
      void this.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: lastUserMessage(req.messages) }],
      }).then((result) => {
        queue.push({ type: 'done', finishReason: getString(result, 'stopReason') });
        queue.end();
      }).catch((reason) => queue.fail(toError(reason)));

      for await (const event of queue) yield event;
    } catch (reason) {
      error('MiniMax Code request failed');
      yield { type: 'error', message: 'MiniMax Code could not complete the request.' };
    } finally {
      req.signal?.removeEventListener('abort', abort);
      this.activeTurn = undefined;
    }
  }

  /** ACP is an agent protocol, not a fill-in-the-middle completions API. */
  async complete(_req: CompletionRequest): Promise<string | undefined> {
    return undefined;
  }

  dispose(): void {
    this.process?.kill();
    this.process = undefined;
    this.sessionId = undefined;
    this.rejectPending(new Error('MiniMax Code connection closed.'));
  }

  private async start(): Promise<void> {
    if (this.sessionId) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const executable = await this.mcodeExecutable();
    const process = childProcess.spawn(executable, ['acp'], { cwd: workspaceFolder(), stdio: 'pipe', windowsHide: true });
    this.process = process;
    process.on('error', () => this.connectionFailed(new Error('MiniMax Code ACP could not start.')));
    process.on('exit', (code) => {
      if (code !== 0) this.connectionFailed(new Error(`MiniMax Code ACP exited with code ${code ?? 'unknown'}.`));
    });
    // Do not copy subprocess stderr into VS Code logs: it can contain request data.
    process.stderr.resume();
    const lines = readline.createInterface({ input: process.stdout });
    lines.on('line', (line) => this.handleLine(line));

    await this.request('initialize', {
      protocolVersion: 1,
      // ACP must know the bridge exists before a session is created. The
      // handlers still deny every file request until agent mode is enabled,
      // and we never advertise a terminal bridge.
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
      clientInfo: { name: 'MiniMax VS Code', version: this.context.extension.packageJSON.version },
    });
    const session = await this.request('session/new', { cwd: workspaceFolder(), mcpServers: [] });
    const sessionId = getString(session, 'sessionId');
    if (!sessionId) throw new Error('MiniMax Code ACP did not return a session ID.');
    this.sessionId = sessionId;
    log('Connected to MiniMax Code through ACP.');
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.process?.stdin.writable) return Promise.reject(new Error('MiniMax Code ACP is not running.'));
    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (reason) => {
        if (reason) {
          this.pending.delete(id);
          reject(toError(reason));
        }
      });
    });
  }

  private notify(method: string, params: unknown): void {
    this.process?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      log('Ignored malformed ACP output.');
      return;
    }
    if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error('MiniMax Code rejected the request.'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'session/update') {
      const params = message.params as { sessionId?: string; update?: Record<string, unknown> } | undefined;
      const update = params?.update;
      if (params?.sessionId === this.sessionId && update?.sessionUpdate === 'agent_message_chunk') {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === 'text' && content.text) this.activeTurn?.push({ type: 'token', delta: content.text });
      }
      return;
    }
    if (typeof message.id !== 'number') return;
    if (message.method === 'session/request_permission') {
      void this.handlePermissionRequest(message.id, message.params);
      return;
    }
    if (message.method === 'fs/read_text_file') {
      void this.handleReadTextFile(message.id, message.params);
      return;
    }
    if (message.method === 'fs/write_text_file') {
      void this.handleWriteTextFile(message.id, message.params);
      return;
    }
    if (message.method?.startsWith('terminal/')) {
      // We do not implement an execution bridge. In particular, the model
      // cannot run Git or publish to GitHub through this extension.
      this.respondError(message.id, 'Terminal access is disabled.');
    }
  }

  private async handlePermissionRequest(id: number, raw: unknown): Promise<void> {
    const request = raw as {
      toolCall?: { kind?: string };
      options?: Array<{ optionId?: string; kind?: string }>;
    } | undefined;
    const kind = request?.toolCall?.kind;
    const allow = this.agentMode && (kind === 'read' || kind === 'edit');
    const option = allow
      ? request?.options?.find((candidate) => candidate.optionId === 'allow-once' || candidate.kind === 'allow_once')
      : undefined;
    if (option?.optionId) {
      this.respond(id, { outcome: { outcome: 'selected', optionId: option.optionId } });
      return;
    }
    this.respond(id, { outcome: { outcome: 'cancelled' } });
    if (kind === 'execute') {
      void vscode.window.showWarningMessage('MiniMax requested a terminal command. Terminal, Git and GitHub actions are blocked by this extension.');
    } else if (!this.agentMode) {
      void vscode.window.showInformationMessage('MiniMax requested file access. Enable MiniMax agent mode first; file requests are otherwise declined.');
    }
  }

  private async handleReadTextFile(id: number, raw: unknown): Promise<void> {
    try {
      if (!this.agentMode) throw new Error('Agent mode is disabled.');
      const params = readParams(raw);
      const target = await this.safeWorkspacePath(params.path, false);
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target));
      if (bytes.byteLength > 1_000_000) throw new Error('Files larger than 1 MB are not sent to MiniMax.');
      const lines = Buffer.from(bytes).toString('utf8').split(/\r?\n/);
      const start = params.line ?? 0;
      const content = params.limit === undefined ? lines.slice(start).join('\n') : lines.slice(start, start + params.limit).join('\n');
      this.respond(id, { content });
    } catch (reason) {
      this.respondError(id, reason instanceof Error ? reason.message : 'Could not read that file.');
    }
  }

  private async handleWriteTextFile(id: number, raw: unknown): Promise<void> {
    try {
      if (!this.agentMode) throw new Error('Agent mode is disabled.');
      const params = writeParams(raw);
      if (Buffer.byteLength(params.content, 'utf8') > 1_000_000) {
        throw new Error('The proposed file is larger than 1 MB and was declined.');
      }
      const target = await this.safeWorkspacePath(params.path, true);
      const uri = vscode.Uri.file(target);
      const dirty = vscode.workspace.textDocuments.some((document) => document.uri.fsPath === target && document.isDirty);
      if (dirty) throw new Error('Save or discard the open unsaved changes before MiniMax can propose this edit.');

      let before = '';
      let exists = true;
      try {
        before = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      } catch (reason) {
        if (!isFileNotFound(reason)) throw reason;
        exists = false;
      }
      if (before === params.content) {
        this.respond(id, null);
        return;
      }

      const relative = path.relative(workspaceFolder(), target) || path.basename(target);
      const proposal = await vscode.workspace.openTextDocument({ content: params.content, language: languageFor(target) });
      const originalUri = exists
        ? uri
        : (await vscode.workspace.openTextDocument({ content: '', language: languageFor(target) })).uri;
      await vscode.commands.executeCommand('vscode.diff', originalUri, proposal.uri, `MiniMax proposal — ${relative}`);
      const choice = await vscode.window.showWarningMessage(
        `MiniMax proposes to ${exists ? 'modify' : 'create'} ${relative}. Review the diff, then apply this change?`,
        { modal: true },
        'Apply change',
        'Reject',
      );
      if (choice !== 'Apply change') throw new Error('The proposed change was rejected.');
      await vscode.workspace.fs.writeFile(uri, Buffer.from(params.content, 'utf8'));
      this.respond(id, null);
    } catch (reason) {
      this.respondError(id, reason instanceof Error ? reason.message : 'Could not apply the proposed file change.');
    }
  }

  private async safeWorkspacePath(requested: string, allowNewFile: boolean): Promise<string> {
    const root = workspaceRoot();
    const target = path.resolve(root, requested);
    if (!isInside(root, target)) throw new Error('Only files inside the open workspace are allowed.');
    const realRoot = await fs.promises.realpath(root);
    const existing = allowNewFile ? await nearestExistingParent(target) : target;
    const realExisting = await fs.promises.realpath(existing);
    if (!isInside(realRoot, realExisting)) throw new Error('Symlinks outside the open workspace are not allowed.');
    return target;
  }

  private respond(id: number, result: unknown): void {
    this.process?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  private respondError(id: number, message: string): void {
    this.process?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n');
  }

  private connectionFailed(reason: Error): void {
    error('MiniMax Code ACP connection failed');
    this.sessionId = undefined;
    this.rejectPending(reason);
    this.activeTurn?.fail(reason);
  }

  private rejectPending(reason: Error): void {
    for (const request of this.pending.values()) request.reject(reason);
    this.pending.clear();
  }

  private async mcodeExecutable(): Promise<string> {
    if (!this.executable && !(await this.isReady())) {
      throw new Error('MiniMax Code is unavailable.');
    }
    if (!this.executable) throw new Error('MiniMax Code is unavailable.');
    return this.executable;
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | undefined;
  private ended = false;
  private failure: Error | undefined;

  push(item: T): void {
    if (this.ended) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value: item, done: false });
    } else this.items.push(item);
  }
  end(): void { this.ended = true; this.flush(); }
  fail(reason: Error): void { this.failure = reason; this.end(); }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const next = await this.next();
      if (next.done) {
        if (this.failure) throw this.failure;
        return;
      }
      yield next.value;
    }
  }
  private next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false });
    if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve) => { this.waiter = resolve; });
  }
  private flush(): void {
    if (this.waiter && this.items.length === 0) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value: undefined as never, done: true });
    }
  }
}

function region(): string {
  return vscode.workspace.getConfiguration('minimax.mcode').get<string>('region', 'global');
}
function mcodeCandidates(): string[] {
  const binName = process.platform === 'win32' ? 'mcode.cmd' : 'mcode';
  return [
    path.join(os.homedir(), '.minimax-code', 'bin', binName),
    'mcode',
  ].filter((candidate, index, all) => {
    // A workspace setting must never control which executable the extension runs.
    return all.indexOf(candidate) === index && (candidate === 'mcode' || fs.existsSync(candidate));
  });
}
function workspaceFolder(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? vscode.workspace.rootPath ?? process.cwd();
}
function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) throw new Error('Open a workspace folder before using agent mode.');
  return folder;
}
function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function nearestExistingParent(target: string): Promise<string> {
  let candidate = target;
  while (true) {
    try {
      await fs.promises.lstat(candidate);
      return candidate;
    } catch (reason) {
      if (!isFileNotFound(reason)) throw reason;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw new Error('Could not resolve a workspace path.');
      candidate = parent;
    }
  }
}
function isFileNotFound(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) return false;
  const code = (reason as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'FileNotFound';
}
function readParams(raw: unknown): { path: string; line?: number; limit?: number } {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid file-read request.');
  const value = raw as Record<string, unknown>;
  if (typeof value.path !== 'string') throw new Error('Invalid file-read request.');
  return {
    path: value.path,
    line: typeof value.line === 'number' ? value.line : undefined,
    limit: typeof value.limit === 'number' ? value.limit : undefined,
  };
}
function writeParams(raw: unknown): { path: string; content: string } {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid file-write request.');
  const value = raw as Record<string, unknown>;
  if (typeof value.path !== 'string' || typeof value.content !== 'string') throw new Error('Invalid file-write request.');
  return { path: value.path, content: value.content };
}
function languageFor(filePath: string): string | undefined {
  return vscode.workspace.getConfiguration('files').get<Record<string, string>>('associations')?.[path.extname(filePath)]
    ?? undefined;
}
function execFile(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { windowsHide: true, timeout: 10_000 }, (reason) => {
      if (reason) reject(toError(reason)); else resolve();
    });
  });
}
function getString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' ? found : undefined;
}
function lastUserMessage(messages: ChatMessage[]): string {
  return [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
}
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
