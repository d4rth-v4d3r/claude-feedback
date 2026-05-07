import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ReviewBatch, ReviewComment, ReviewMessage } from "./types";
import { ReviewEditorHints } from "./reviewEditorHints";
import { ReviewStore, commentBodyForSend } from "./store";
import {
  ReviewCommentsController,
  isReviewComment,
} from "./reviewCommentsController";
import { ParentBranchResolver } from "./parentBranchResolver";
import { openFileDiffVsParent } from "./diffOpener";
import {
  PendingTreeProvider,
  RepoNode,
  WorktreeNode,
  FileNode,
} from "./pendingTreeProvider";
import {
  ResolvedTreeProvider,
  BatchNode,
  BatchFileNode,
} from "./resolvedTreeProvider";

const CLAUDE_TUI_SETTLE_MS = 2800;
const CLAUDE_LAUNCH_DETECT_MS = 14_000;
const CLAUDE_FALLBACK_PASTE_DELAY_MS = 3800;

export function activate(context: vscode.ExtensionContext): void {
  const store = new ReviewStore(context);
  const locator = new LocationMetadataResolver();
  const parentResolver = new ParentBranchResolver();
  const editorHints = new ReviewEditorHints(context, () =>
    store.getActivePending().filter((c) => isWorkspaceVisible(c.workspaceFolderPath))
  );
  const commentsController = new ReviewCommentsController(store, async (uri, line, body) => {
    await addCommentForUriAndLine(store, locator, uri, line, body);
  });
  const pendingTree = new PendingTreeProvider(store);
  const resolvedTree = new ResolvedTreeProvider(store);

  context.subscriptions.push(store.onDidChange(() => editorHints.refresh()));
  context.subscriptions.push(editorHints, commentsController, pendingTree, resolvedTree);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("codeReviewPending", pendingTree),
    vscode.window.registerTreeDataProvider("codeReviewResolved", resolvedTree)
  );

  // --- Commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand("codeReview.openSidebar", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.codeReviewContainer");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeReview.addComment", async () => {
      await addCommentFromActiveEditor(store, locator);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeReview.openFileDiff", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        return;
      }
      await openFileDiffVsParent(target, parentResolver);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codeReview.replyComment",
      async (reply: vscode.CommentReply) => {
        await commentsController.handleReply(reply);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codeReview.editComment",
      async (comment: vscode.Comment) => {
        if (!isReviewComment(comment)) {
          return;
        }
        const next = await vscode.window.showInputBox({
          title: "Edit review comment",
          value: comment.body instanceof vscode.MarkdownString ? comment.body.value : String(comment.body ?? ""),
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim().length === 0 ? "Comment cannot be empty." : undefined),
        });
        if (next === undefined) {
          return;
        }
        await commentsController.editMessage(
          comment.reviewCommentId,
          comment.reviewMessageId,
          next
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codeReview.deleteComment",
      async (comment: vscode.Comment) => {
        if (!isReviewComment(comment)) {
          return;
        }
        await commentsController.deleteMessage(
          comment.reviewCommentId,
          comment.reviewMessageId
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codeReview.deleteThread",
      async (thread: vscode.CommentThread) => {
        const first = thread.comments[0];
        if (first && isReviewComment(first)) {
          await commentsController.deleteThread(first.reviewCommentId);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codeReview.toggleResolved",
      async (thread: vscode.CommentThread) => {
        const first = thread.comments[0];
        if (first && isReviewComment(first)) {
          await commentsController.toggleResolved(first.reviewCommentId);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codeReview.setParentBranch",
      async (target?: WorktreeNode | vscode.Uri) => {
        await setParentBranchInteractive(parentResolver, target);
      }
    )
  );

  // --- Send / clear / rollback (preserve existing UX) ---

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codeReview.sendForReview",
      async (target?: WorktreeNode) => {
        await sendForReview(store, locator, target?.workspaceFolderPath);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codeReview.sendInCurrentTerminal",
      async (target?: WorktreeNode) => {
        await sendInCurrentTerminal(store, target?.workspaceFolderPath);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codeReview.clearPending",
      async (target?: WorktreeNode) => {
        await clearPending(store, target?.workspaceFolderPath);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeReview.rollbackBatch", async (node?: BatchNode) => {
      const batchId = node?.batch.id;
      if (!batchId) {
        return;
      }
      await rollbackBatch(store, batchId);
    })
  );

  // Keyboard quick-access menu (kept for compat with existing keybinding)
  context.subscriptions.push(
    vscode.commands.registerCommand("codeReview.quickReviewMenu", async () => {
      const picked = await vscode.window.showQuickPick<
        vscode.QuickPickItem & { action: "add" | "sidebar" | "diff" }
      >(
        [
          {
            label: "$(comment-add) Add review comment",
            description: "For the current line · pending until you send the batch",
            action: "add",
          },
          {
            label: "$(diff) Open diff vs parent branch",
            description: "Opens current file diffed against merge-base with parent",
            action: "diff",
          },
          {
            label: "$(list-tree) Open Code Review",
            description: "Pending list, resolved batches, send for review",
            action: "sidebar",
          },
        ],
        { placeHolder: "Choose an action", title: "Code review", ignoreFocusOut: true }
      );
      if (!picked) {
        return;
      }
      if (picked.action === "add") {
        await vscode.commands.executeCommand("codeReview.addComment");
      } else if (picked.action === "diff") {
        await vscode.commands.executeCommand("codeReview.openFileDiff");
      } else {
        await vscode.commands.executeCommand("codeReview.openSidebar");
      }
    })
  );
}

export function deactivate(): void {
  // no-op
}

// ---------- Adding comments ----------

async function addCommentFromActiveEditor(
  store: ReviewStore,
  locator: LocationMetadataResolver
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Open a file in the editor before adding a review comment.");
    return;
  }

  const document = editor.document;
  if (document.uri.scheme !== "file") {
    vscode.window.showWarningMessage("Review comments can only be added on local files on disk.");
    return;
  }

  const lineNumber = editor.selection.active.line + 1;
  const rawLine = document.lineAt(lineNumber - 1).text.trim();
  const short = rawLine.length > 100 ? `${rawLine.slice(0, 100)}…` : rawLine;
  const lineHint = short ? `Line ${lineNumber}: ${short}` : `Line ${lineNumber}`;

  const text = await vscode.window.showInputBox({
    title: "Review comment",
    prompt: lineHint,
    placeHolder: "Describe the change or concern…",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? "Comment cannot be empty." : undefined),
  });
  if (text === undefined) {
    return;
  }

  await persistNewComment(store, locator, document, lineNumber, text);
  await vscode.commands.executeCommand("workbench.view.extension.codeReviewContainer");
  vscode.window.showInformationMessage("Review comment added to Pending.");
}

async function addCommentForUriAndLine(
  store: ReviewStore,
  locator: LocationMetadataResolver,
  uri: vscode.Uri,
  line1Based: number,
  body: string
): Promise<void> {
  if (uri.scheme !== "file") {
    return;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  await persistNewComment(store, locator, document, line1Based, body);
}

async function persistNewComment(
  store: ReviewStore,
  locator: LocationMetadataResolver,
  document: vscode.TextDocument,
  line1Based: number,
  body: string
): Promise<void> {
  const text = body.trim();
  if (!text) {
    return;
  }
  const lineIndex = Math.max(0, Math.min(line1Based - 1, document.lineCount - 1));
  const contextLines = readContext(document, lineIndex);
  const metadata = locator.getLocationMetadata(document.uri);
  const id = makeId();
  const message: ReviewMessage = {
    id: `${id}-m0`,
    author: "You",
    body: text,
    createdAt: new Date().toISOString(),
  };
  const newComment: ReviewComment = {
    id,
    filePath: document.uri.fsPath,
    relativePath: metadata.relativePath,
    line: lineIndex + 1,
    context: contextLines,
    messages: [message],
    status: "pending",
    repoName: metadata.repoName,
    repoPath: metadata.repoPath,
    worktreeName: metadata.worktreeName,
    workspaceFolderPath: metadata.workspaceFolderPath,
    branchName: metadata.branchName,
    createdAt: message.createdAt,
  };
  await store.update((state) => {
    state.pending = [newComment, ...state.pending];
  });
}

function readContext(document: vscode.TextDocument, lineIndex: number): string[] {
  const start = Math.max(lineIndex - 2, 0);
  const end = Math.min(lineIndex + 2, document.lineCount - 1);
  const lines: string[] = [];
  for (let i = start; i <= end; i += 1) {
    const marker = i === lineIndex ? ">" : " ";
    lines.push(`${marker} L${i + 1}: ${document.lineAt(i).text}`);
  }
  return lines;
}

// ---------- Send / clear / rollback ----------

async function clearPending(store: ReviewStore, workspaceFolderPath?: string): Promise<void> {
  const pending = store.getState().pending;
  if (!pending.length) {
    return;
  }
  if (!workspaceFolderPath) {
    await store.update((state) => {
      state.pending = [];
    });
    return;
  }
  await store.update((state) => {
    state.pending = state.pending.filter((c) => c.workspaceFolderPath !== workspaceFolderPath);
  });
}

async function rollbackBatch(store: ReviewStore, batchId: string): Promise<void> {
  await store.update((state) => {
    const idx = state.reviews.findIndex((b) => b.id === batchId);
    if (idx < 0) {
      return;
    }
    const [batch] = state.reviews.splice(idx, 1);
    state.pending = [...batch.comments, ...state.pending];
  });
}

async function sendForReview(
  store: ReviewStore,
  locator: LocationMetadataResolver,
  workspaceFolderPath?: string
): Promise<void> {
  const targetComments = getTargetCommentsForSend(store, workspaceFolderPath);
  if (!targetComments.length) {
    vscode.window.showWarningMessage("No pending review comments to send.");
    return;
  }

  const cwd = resolveSendCwd(workspaceFolderPath, targetComments);
  if (!cwd) {
    vscode.window.showWarningMessage(
      "Pending comments span multiple workspace folders. Send from a worktree node in the Code Review sidebar."
    );
    return;
  }

  const copiedText = buildReviewCopyText(targetComments);
  await vscode.env.clipboard.writeText(copiedText);
  await commitReviewBatch(store, targetComments, copiedText, workspaceFolderPath);

  const terminal = vscode.window.createTerminal({
    name: "Code review · Claude",
    cwd,
    location: resolveClaudeTerminalLocation(),
  });
  terminal.show();
  await waitForShellIntegrationReady(terminal, 5000);
  const launchPromise = waitForClaudeShellLaunch(terminal, CLAUDE_LAUNCH_DETECT_MS);
  terminal.sendText("claude", true);
  const sawLaunch = await launchPromise;
  await sleep(sawLaunch ? CLAUDE_TUI_SETTLE_MS : CLAUDE_FALLBACK_PASTE_DELAY_MS);
  if (!sawLaunch) {
    vscode.window.showWarningMessage(
      "Claude did not report as started in time; pasted anyway. If zsh ran part of the review text, paste from the clipboard after Claude is ready."
    );
  }

  sendReviewTextToTerminal(terminal, copiedText);

  vscode.window.showInformationMessage(
    "Review saved; Claude started in this worktree and review text pasted (clipboard updated)."
  );
}

async function sendInCurrentTerminal(
  store: ReviewStore,
  workspaceFolderPath?: string
): Promise<void> {
  const active = vscode.window.activeTerminal;
  if (!active) {
    return;
  }

  const targetComments = getTargetCommentsForSend(store, workspaceFolderPath);
  if (!targetComments.length) {
    vscode.window.showWarningMessage("No pending review comments to send.");
    return;
  }
  if (resolveSendCwd(workspaceFolderPath, targetComments) === undefined) {
    vscode.window.showWarningMessage(
      "Pending comments span multiple workspace folders. Send from a worktree node in the Code Review sidebar."
    );
    return;
  }

  const copiedText = buildReviewCopyText(targetComments);
  await vscode.env.clipboard.writeText(copiedText);
  await commitReviewBatch(store, targetComments, copiedText, workspaceFolderPath);
  sendReviewTextToTerminal(active, copiedText);

  vscode.window.showInformationMessage(
    "Review saved; pasted into active terminal for Claude Code (clipboard updated)."
  );
}

function getTargetCommentsForSend(
  store: ReviewStore,
  workspaceFolderPath?: string
): ReviewComment[] {
  const active = store.getActivePending();
  return workspaceFolderPath
    ? active.filter((c) => c.workspaceFolderPath === workspaceFolderPath)
    : active;
}

function resolveSendCwd(
  workspaceFolderPath: string | undefined,
  targetComments: ReviewComment[]
): string | undefined {
  if (workspaceFolderPath) {
    return workspaceFolderPath;
  }
  const folders = [...new Set(targetComments.map((c) => c.workspaceFolderPath))];
  return folders.length === 1 ? folders[0] : undefined;
}

async function commitReviewBatch(
  store: ReviewStore,
  targetComments: ReviewComment[],
  copiedText: string,
  workspaceFolderPath?: string
): Promise<void> {
  const idsToRemove = new Set(targetComments.map((c) => c.id));
  const batch: ReviewBatch = {
    id: makeId(),
    createdAt: new Date().toISOString(),
    comments: [...targetComments],
    copiedText,
  };
  await store.update((state) => {
    state.reviews = [batch, ...state.reviews];
    state.pending = workspaceFolderPath
      ? state.pending.filter(
          (c) => c.workspaceFolderPath !== workspaceFolderPath || !idsToRemove.has(c.id)
        )
      : state.pending.filter((c) => !idsToRemove.has(c.id));
  });
}

// ---------- Parent branch interactive setter ----------

async function setParentBranchInteractive(
  resolver: ParentBranchResolver,
  target?: WorktreeNode | vscode.Uri
): Promise<void> {
  let probeUri: vscode.Uri | undefined;
  if (target instanceof vscode.Uri) {
    probeUri = target;
  } else if (target && "workspaceFolderPath" in target) {
    probeUri = vscode.Uri.file(target.workspaceFolderPath);
  } else {
    probeUri = vscode.window.activeTextEditor?.document.uri;
    if (!probeUri) {
      const folder = vscode.workspace.workspaceFolders?.[0];
      probeUri = folder?.uri;
    }
  }
  if (!probeUri) {
    vscode.window.showWarningMessage("Open a file in the target repo before setting its parent branch.");
    return;
  }

  const current = await resolver.resolve(probeUri);
  const next = await vscode.window.showInputBox({
    title: "Set parent branch for diff",
    prompt: current
      ? `On branch ${current.branchName} · current parent: ${current.parentRef} (${current.source})`
      : "Enter the parent branch (e.g. main, origin/main, parent-feature-branch)",
    value: current?.parentRef ?? "main",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? "Parent ref cannot be empty." : undefined),
  });
  if (next === undefined) {
    return;
  }

  const ok = await resolver.setParentForCurrentBranch(probeUri, next.trim());
  if (!ok) {
    vscode.window.showWarningMessage("Could not set parent branch (no git repo, or branch is detached).");
    return;
  }
  vscode.window.showInformationMessage(`Parent branch set to '${next.trim()}'.`);
}

// ---------- Send pipeline plumbing (kept verbatim from old extension) ----------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveClaudeTerminalLocation():
  | vscode.TerminalLocation
  | vscode.TerminalEditorLocationOptions {
  const loc = vscode.workspace.getConfiguration("codeReview").get<string>("claudeTerminalLocation", "editor");
  if (loc === "panel") {
    return vscode.TerminalLocation.Panel;
  }
  const viewColumn =
    vscode.window.activeTextEditor?.viewColumn ??
    vscode.window.tabGroups.activeTabGroup?.viewColumn ??
    vscode.ViewColumn.One;
  return { viewColumn, preserveFocus: false };
}

async function waitForShellIntegrationReady(terminal: vscode.Terminal, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (terminal.shellIntegration) {
      return;
    }
    await sleep(80);
  }
}

function commandLineLooksLikeClaudeLaunch(commandLine: string): boolean {
  const t = commandLine.trim().toLowerCase();
  if (!t.length) {
    return false;
  }
  if (/\bclaude\b/.test(t)) {
    return true;
  }
  return t.includes("claude-code") || t.includes("@anthropic/claude") || t.includes("anthropic.claude");
}

function waitForClaudeShellLaunch(terminal: vscode.Terminal, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) {
        return;
      }
      done = true;
      disposable.dispose();
      clearTimeout(timer);
      resolve(ok);
    };

    const disposable = vscode.window.onDidStartTerminalShellExecution((event) => {
      if (event.terminal !== terminal) {
        return;
      }
      try {
        const value = event.execution.commandLine.value;
        if (commandLineLooksLikeClaudeLaunch(value)) {
          finish(true);
        }
      } catch {
        // commandLine may be incomplete in rare cases
      }
    });

    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function buildReviewCopyText(comments: ReviewComment[]): string {
  const lines = comments.map(
    (item, index) => `  ${index + 1}. @${item.filePath} L${item.line}: ${formatBodyForLine(commentBodyForSend(item))}`
  );

  return [
    "Please address the following code review comments. Run git diff (or git diff HEAD) to see the full context of any changes, especially for deleted lines.",
    "",
    ...lines,
  ].join("\n");
}

function formatBodyForLine(body: string): string {
  return body.replace(/\r?\n/g, "\n     ");
}

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

function sendReviewTextToTerminal(terminal: vscode.Terminal, text: string): void {
  const safe = text.replace(/\u001b/g, "");
  terminal.sendText(BRACKETED_PASTE_START + safe + BRACKETED_PASTE_END, false);
}

function isWorkspaceVisible(workspaceFolderPath: string): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.some((folder) => folder.uri.fsPath === workspaceFolderPath);
}

// ---------- Repo / worktree / branch metadata (extracted from previous CodeReviewSidebarProvider) ----------

type LocationMetadata = {
  relativePath: string;
  repoName: string;
  repoPath: string;
  worktreeName: string;
  workspaceFolderPath: string;
  branchName: string;
};

class LocationMetadataResolver {
  private branchCache = new Map<string, string>();

  getLocationMetadata(uri: vscode.Uri): LocationMetadata {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const workspaceFolderPath = workspaceFolder?.uri.fsPath ?? path.dirname(uri.fsPath);
    const discoveredRepoPath = this.findGitRoot(path.dirname(uri.fsPath)) ?? workspaceFolderPath;
    const gitIdentity = this.getGitIdentity(discoveredRepoPath);
    const relativePath =
      path.relative(gitIdentity.worktreeRootPath, uri.fsPath) || path.basename(uri.fsPath);
    const branchName = this.getBranchName(gitIdentity.worktreeRootPath);
    return {
      relativePath,
      repoName: gitIdentity.repoName,
      repoPath: gitIdentity.repoRootPath,
      worktreeName: gitIdentity.worktreeName,
      workspaceFolderPath,
      branchName,
    };
  }

  private getGitIdentity(candidateRepoPath: string): {
    repoRootPath: string;
    worktreeRootPath: string;
    repoName: string;
    worktreeName: string;
  } {
    try {
      const worktreeRootPath = execSync("git rev-parse --show-toplevel", {
        cwd: candidateRepoPath,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }).trim();
      const commonGitDir = execSync(
        "git rev-parse --path-format=absolute --git-common-dir",
        {
          cwd: candidateRepoPath,
          stdio: ["ignore", "pipe", "ignore"],
          encoding: "utf8",
        }
      ).trim();

      const repoRootPath = path.dirname(commonGitDir);
      return {
        repoRootPath,
        worktreeRootPath,
        repoName: path.basename(repoRootPath),
        worktreeName: path.basename(worktreeRootPath),
      };
    } catch {
      return {
        repoRootPath: candidateRepoPath,
        worktreeRootPath: candidateRepoPath,
        repoName: path.basename(candidateRepoPath),
        worktreeName: path.basename(candidateRepoPath),
      };
    }
  }

  private findGitRoot(startDir: string): string | undefined {
    let current = startDir;
    while (true) {
      if (fs.existsSync(path.join(current, ".git"))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }

  private getBranchName(repoPath: string): string {
    const cached = this.branchCache.get(repoPath);
    if (cached) {
      return cached;
    }
    try {
      const branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: repoPath,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }).trim();
      const resolved = branch || "detached";
      this.branchCache.set(repoPath, resolved);
      return resolved;
    } catch {
      this.branchCache.set(repoPath, "unknown");
      return "unknown";
    }
  }
}

// Re-export tree node types so the package.json `view/item/context` menu
// `when` clauses can target them by `viewItem == codeReview.<kind>`.
export { RepoNode, WorktreeNode, FileNode, BatchNode, BatchFileNode };
