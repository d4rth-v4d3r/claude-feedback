"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const node_child_process_1 = require("node:child_process");
const WORKSPACE_STATE_KEY = "codeReviewSidebarState";
const GLOBAL_STATE_KEY = "codeReviewSidebarState.global";
function activate(context) {
    const provider = new CodeReviewSidebarProvider(context);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider("codeReviewSidebar", provider, {
        webviewOptions: { retainContextWhenHidden: true },
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.openSidebar", async () => {
        await vscode.commands.executeCommand("workbench.view.extension.codeReviewContainer");
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.addComment", async () => {
        await provider.addCommentFromActiveEditor();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.clearPending", async () => {
        await provider.clearPending();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.sendForReview", async () => {
        await provider.sendForReview();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.sendInCurrentTerminal", async () => {
        await provider.sendInCurrentTerminal();
    }));
}
class CodeReviewSidebarProvider {
    constructor(context) {
        this.context = context;
        this.branchCache = new Map();
        const globalState = this.context.globalState.get(GLOBAL_STATE_KEY);
        if (globalState) {
            this.state = globalState;
            return;
        }
        const workspaceState = this.context.workspaceState.get(WORKSPACE_STATE_KEY) ?? { pending: [], reviews: [] };
        this.state = workspaceState;
        void this.context.globalState.update(GLOBAL_STATE_KEY, workspaceState);
    }
    resolveWebviewView(webviewView) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
        };
        const claudeIconUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "claude-spark.svg"));
        webviewView.webview.html = getWebviewHtml(webviewView.webview, this.context.extensionUri, claudeIconUri);
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case "ready":
                    this.postState();
                    break;
                case "openComment":
                    await this.openComment(message.commentId);
                    break;
                case "sendForReview":
                    await this.sendForReview();
                    break;
                case "clearPending":
                    await this.clearPending();
                    break;
                case "sendForReviewWorktree":
                    await this.sendForReview(message.workspaceFolderPath);
                    break;
                case "sendInCurrentTerminalWorktree":
                    await this.sendInCurrentTerminal(message.workspaceFolderPath);
                    break;
                case "clearPendingWorktree":
                    await this.clearPending(message.workspaceFolderPath);
                    break;
                case "rollbackBatch":
                    await this.rollbackBatch(message.batchId);
                    break;
                case "updateComment":
                    await this.updateComment(message.commentId, message.commentText);
                    break;
                case "deleteComment":
                    await this.deleteComment(message.commentId);
                    break;
            }
        });
        this.postState();
    }
    async addCommentFromActiveEditor() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("Open a file in the editor before adding a review comment.");
            return;
        }
        const lineNumber = editor.selection.active.line + 1;
        const input = await vscode.window.showInputBox({
            title: "Code review comment",
            prompt: "Write feedback for this line",
            placeHolder: "Example: This logic should be extracted into a helper.",
            ignoreFocusOut: true,
            validateInput: (value) => (value.trim().length ? null : "Comment is required."),
        });
        if (!input) {
            return;
        }
        const document = editor.document;
        const contextLines = this.readContext(document, lineNumber - 1);
        const metadata = this.getLocationMetadata(document.uri);
        const newComment = {
            id: makeId(),
            filePath: document.uri.fsPath,
            relativePath: metadata.relativePath,
            line: lineNumber,
            comment: input.trim(),
            context: contextLines,
            repoName: metadata.repoName,
            repoPath: metadata.repoPath,
            worktreeName: metadata.worktreeName,
            workspaceFolderPath: metadata.workspaceFolderPath,
            branchName: metadata.branchName,
            createdAt: new Date().toISOString(),
        };
        this.state.pending = [newComment, ...this.state.pending];
        await this.saveState();
        this.postState();
        await vscode.commands.executeCommand("workbench.view.extension.codeReviewContainer");
        vscode.window.showInformationMessage("Review comment added to Pending.");
    }
    async clearPending(workspaceFolderPath) {
        if (!this.state.pending.length || !workspaceFolderPath) {
            if (!this.state.pending.length) {
                return;
            }
            this.state.pending = [];
            await this.saveState();
            this.postState();
            return;
        }
        const nextPending = this.state.pending.filter((comment) => comment.workspaceFolderPath !== workspaceFolderPath);
        if (nextPending.length === this.state.pending.length) {
            return;
        }
        this.state.pending = nextPending;
        await this.saveState();
        this.postState();
    }
    async sendForReview(workspaceFolderPath) {
        const targetComments = this.getTargetCommentsForSend(workspaceFolderPath);
        if (!targetComments.length) {
            vscode.window.showWarningMessage("No pending review comments to send.");
            return;
        }
        const cwd = this.resolveSendCwd(workspaceFolderPath, targetComments);
        if (!cwd) {
            vscode.window.showWarningMessage("Pending comments span multiple workspace folders. Use the send actions under each worktree in the sidebar.");
            return;
        }
        const copiedText = buildReviewCopyText(targetComments);
        await vscode.env.clipboard.writeText(copiedText);
        this.commitReviewBatch(targetComments, copiedText, workspaceFolderPath);
        await this.saveState();
        this.postState();
        const terminal = vscode.window.createTerminal({
            name: "Code review · Claude",
            cwd,
        });
        terminal.show();
        sendReviewTextToTerminal(terminal, copiedText);
        vscode.window.showInformationMessage("Review saved; new terminal opened with review text for Claude Code (clipboard updated).");
    }
    async sendInCurrentTerminal(workspaceFolderPath) {
        const active = vscode.window.activeTerminal;
        if (!active) {
            return;
        }
        const targetComments = this.getTargetCommentsForSend(workspaceFolderPath);
        if (!targetComments.length) {
            vscode.window.showWarningMessage("No pending review comments to send.");
            return;
        }
        if (this.resolveSendCwd(workspaceFolderPath, targetComments) === undefined) {
            vscode.window.showWarningMessage("Pending comments span multiple workspace folders. Use the send actions under each worktree in the sidebar.");
            return;
        }
        const copiedText = buildReviewCopyText(targetComments);
        await vscode.env.clipboard.writeText(copiedText);
        this.commitReviewBatch(targetComments, copiedText, workspaceFolderPath);
        await this.saveState();
        this.postState();
        sendReviewTextToTerminal(active, copiedText);
        vscode.window.showInformationMessage("Review saved; pasted into active terminal for Claude Code (clipboard updated).");
    }
    getTargetCommentsForSend(workspaceFolderPath) {
        return workspaceFolderPath
            ? this.state.pending.filter((comment) => comment.workspaceFolderPath === workspaceFolderPath)
            : this.state.pending;
    }
    /**
     * When `workspaceFolderPath` is omitted, requires all target comments to share one folder.
     */
    resolveSendCwd(workspaceFolderPath, targetComments) {
        if (workspaceFolderPath) {
            return workspaceFolderPath;
        }
        const folders = [...new Set(targetComments.map((c) => c.workspaceFolderPath))];
        if (folders.length !== 1) {
            return undefined;
        }
        return folders[0];
    }
    commitReviewBatch(targetComments, copiedText, workspaceFolderPath) {
        const batch = {
            id: makeId(),
            createdAt: new Date().toISOString(),
            comments: [...targetComments],
            copiedText,
        };
        this.state.reviews = [batch, ...this.state.reviews];
        this.state.pending = workspaceFolderPath
            ? this.state.pending.filter((comment) => comment.workspaceFolderPath !== workspaceFolderPath)
            : [];
    }
    async rollbackBatch(batchId) {
        const index = this.state.reviews.findIndex((batch) => batch.id === batchId);
        if (index < 0) {
            return;
        }
        const [batch] = this.state.reviews.splice(index, 1);
        this.state.pending = [...batch.comments, ...this.state.pending];
        await this.saveState();
        this.postState();
    }
    async openComment(commentId) {
        const allComments = [
            ...this.state.pending.map((comment) => this.normalizeComment(comment)),
            ...this.state.reviews.flatMap((batch) => batch.comments.map((comment) => this.normalizeComment(comment))),
        ];
        const target = allComments.find((comment) => comment.id === commentId);
        if (!target) {
            return;
        }
        const document = await vscode.workspace.openTextDocument(target.filePath);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        const targetLine = Math.max(target.line - 1, 0);
        const range = new vscode.Range(targetLine, 0, targetLine, 0);
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }
    async updateComment(commentId, commentText) {
        const nextText = String(commentText ?? "").trim();
        if (!nextText.length) {
            return;
        }
        const pendingMatch = this.state.pending.find((item) => item.id === commentId);
        if (pendingMatch) {
            pendingMatch.comment = nextText;
            await this.saveState();
            this.postState();
            return;
        }
        for (const batch of this.state.reviews) {
            const match = batch.comments.find((item) => item.id === commentId);
            if (match) {
                match.comment = nextText;
                batch.copiedText = buildReviewCopyText(batch.comments);
                await this.saveState();
                this.postState();
                return;
            }
        }
    }
    async deleteComment(commentId) {
        const pendingBefore = this.state.pending.length;
        this.state.pending = this.state.pending.filter((item) => item.id !== commentId);
        if (this.state.pending.length !== pendingBefore) {
            await this.saveState();
            this.postState();
            return;
        }
        for (const batch of this.state.reviews) {
            const before = batch.comments.length;
            batch.comments = batch.comments.filter((item) => item.id !== commentId);
            if (batch.comments.length !== before) {
                batch.copiedText = buildReviewCopyText(batch.comments);
                this.state.reviews = this.state.reviews.filter((candidate) => candidate.comments.length > 0);
                await this.saveState();
                this.postState();
                return;
            }
        }
    }
    readContext(document, lineIndex) {
        const start = Math.max(lineIndex - 2, 0);
        const end = Math.min(lineIndex + 2, document.lineCount - 1);
        const lines = [];
        for (let i = start; i <= end; i += 1) {
            const marker = i === lineIndex ? ">" : " ";
            const text = document.lineAt(i).text;
            lines.push(`${marker} L${i + 1}: ${text}`);
        }
        return lines;
    }
    async saveState() {
        await this.context.globalState.update(GLOBAL_STATE_KEY, this.state);
    }
    postState() {
        const pending = this.state.pending
            .map((comment) => this.normalizeComment(comment))
            .filter((comment) => this.isWorkspaceVisible(comment.workspaceFolderPath));
        const reviews = this.state.reviews
            .map((batch) => ({
            ...batch,
            comments: batch.comments
                .map((comment) => this.normalizeComment(comment))
                .filter((comment) => this.isWorkspaceVisible(comment.workspaceFolderPath)),
        }))
            .filter((batch) => batch.comments.length > 0);
        this.view?.webview.postMessage({
            type: "state",
            state: { pending, reviews },
        });
    }
    normalizeComment(comment) {
        // Always rehydrate location metadata from file path so older persisted
        // comments get corrected when grouping logic changes.
        const metadata = this.getLocationMetadata(vscode.Uri.file(comment.filePath));
        return {
            ...comment,
            relativePath: metadata.relativePath,
            repoName: metadata.repoName,
            repoPath: metadata.repoPath,
            worktreeName: metadata.worktreeName,
            workspaceFolderPath: metadata.workspaceFolderPath,
            branchName: metadata.branchName,
        };
    }
    isWorkspaceVisible(workspaceFolderPath) {
        const folders = vscode.workspace.workspaceFolders ?? [];
        return folders.some((folder) => folder.uri.fsPath === workspaceFolderPath);
    }
    getLocationMetadata(uri) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        const workspaceFolderPath = workspaceFolder?.uri.fsPath ?? path.dirname(uri.fsPath);
        const discoveredRepoPath = this.findGitRoot(path.dirname(uri.fsPath)) ?? workspaceFolderPath;
        const gitIdentity = this.getGitIdentity(discoveredRepoPath);
        const relativePath = path.relative(gitIdentity.worktreeRootPath, uri.fsPath) || path.basename(uri.fsPath);
        const repoPath = gitIdentity.repoRootPath;
        const repoName = gitIdentity.repoName;
        const worktreeName = gitIdentity.worktreeName;
        const branchName = this.getBranchName(gitIdentity.worktreeRootPath);
        return { relativePath, repoName, repoPath, worktreeName, workspaceFolderPath, branchName };
    }
    getGitIdentity(candidateRepoPath) {
        try {
            const worktreeRootPath = (0, node_child_process_1.execSync)("git rev-parse --show-toplevel", {
                cwd: candidateRepoPath,
                stdio: ["ignore", "pipe", "ignore"],
                encoding: "utf8",
            }).trim();
            const commonGitDir = (0, node_child_process_1.execSync)("git rev-parse --path-format=absolute --git-common-dir", {
                cwd: candidateRepoPath,
                stdio: ["ignore", "pipe", "ignore"],
                encoding: "utf8",
            }).trim();
            const repoRootPath = path.dirname(commonGitDir);
            return {
                repoRootPath,
                worktreeRootPath,
                repoName: path.basename(repoRootPath),
                worktreeName: path.basename(worktreeRootPath),
            };
        }
        catch {
            return {
                repoRootPath: candidateRepoPath,
                worktreeRootPath: candidateRepoPath,
                repoName: path.basename(candidateRepoPath),
                worktreeName: path.basename(candidateRepoPath),
            };
        }
    }
    findGitRoot(startDir) {
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
    getBranchName(repoPath) {
        const cached = this.branchCache.get(repoPath);
        if (cached) {
            return cached;
        }
        try {
            const branch = (0, node_child_process_1.execSync)("git rev-parse --abbrev-ref HEAD", {
                cwd: repoPath,
                stdio: ["ignore", "pipe", "ignore"],
                encoding: "utf8",
            }).trim();
            const resolved = branch || "detached";
            this.branchCache.set(repoPath, resolved);
            return resolved;
        }
        catch {
            this.branchCache.set(repoPath, "unknown");
            return "unknown";
        }
    }
}
function makeId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
function buildReviewCopyText(comments) {
    const lines = comments.map((item, index) => `  ${index + 1}. @${item.filePath} L${item.line}: ${item.comment}`);
    return [
        "Please address the following code review comments. Run `git diff` (or `git diff HEAD`) to see the full context of any changes, especially for deleted lines.",
        "",
        ...lines,
    ].join("\n");
}
/** Bracketed paste (OSC 200/201) so multiline review text is not executed by the shell line-by-line. */
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
function sendReviewTextToTerminal(terminal, text) {
    const safe = text.replace(/\u001b/g, "");
    terminal.sendText(BRACKETED_PASTE_START + safe + BRACKETED_PASTE_END, false);
}
function getWebviewHtml(webview, extensionUri, claudeIconUri) {
    const nonce = makeId().replace(/[^a-z0-9]/gi, "");
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';`;
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "node_modules", "@vscode", "codicons", "dist", "codicon.css"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${codiconUri}" rel="stylesheet" />
  <style>
    :root {
      color-scheme: light dark;
    }
    * {
      box-sizing: border-box;
      min-width: 0;
    }
    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      overflow-x: hidden;
    }
    .tabs {
      display: flex;
      gap: 4px;
      padding: 8px 8px 0;
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
      z-index: 10;
    }
    .tab {
      flex: 1;
      border: 0;
      background: transparent;
      color: var(--vscode-foreground);
      padding: 8px 8px;
      cursor: pointer;
      font-weight: 600;
      border-top-left-radius: 8px;
      border-top-right-radius: 8px;
    }
    .tab.active {
      background: color-mix(in srgb, var(--vscode-focusBorder) 16%, transparent);
      box-shadow: inset 0 -2px 0 var(--vscode-focusBorder);
    }
    .list {
      padding: 10px;
      padding-bottom: 96px;
      display: grid;
      gap: 10px;
    }
    .card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 10px;
      background: var(--vscode-sideBar-background);
      max-width: 100%;
      overflow: hidden;
    }
    .meta {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
      font-size: 12px;
      opacity: 0.8;
    }
    .path-link {
      display: inline-flex;
      align-items: center;
      margin-bottom: 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      cursor: pointer;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .path-link:hover {
      color: var(--vscode-textLink-activeForeground);
      text-decoration: underline;
    }
    .path-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }
    .icon-btn {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 6px;
      padding: 2px 8px;
      min-width: 0;
      line-height: 1.2;
    }
    .comment {
      margin-bottom: 8px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .code {
      margin: 0;
      background: var(--vscode-editor-background);
      border-radius: 6px;
      padding: 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      overflow-x: auto;
      max-width: 100%;
      border: 1px solid var(--vscode-panel-border);
    }
    .actions {
      margin-top: 8px;
      display: flex;
      gap: 8px;
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .worktree-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin: 4px 0 8px;
    }
    .worktree-actions > button {
      font-size: 12px;
      padding: 4px 8px;
    }
    .claude-send-group {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .claude-icon-wrap {
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      opacity: 0.92;
    }
    .claude-icon-wrap img {
      width: 18px;
      height: 18px;
      display: block;
    }
    .batch-title {
      font-weight: 600;
      margin-bottom: 6px;
    }
    .summary {
      font-size: 12px;
      opacity: 0.9;
      margin-bottom: 8px;
    }
    .hidden {
      display: none;
    }
    .empty {
      opacity: 0.8;
      font-style: italic;
    }
    .editor-row {
      display: grid;
      gap: 8px;
      margin-top: 8px;
    }
    .editor-input {
      width: 100%;
      min-height: 64px;
      resize: vertical;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 6px;
      padding: 8px;
      font-family: var(--vscode-font-family);
      font-size: 12px;
    }
    .tree-node {
      display: grid;
      gap: 6px;
    }
    .tree-row {
      width: 100%;
      border: 0;
      background: transparent;
      color: var(--vscode-foreground);
      text-align: left;
      font-weight: 600;
      padding: 2px 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
    }
    .tree-row-label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .tree-row-label.worktree {
      margin-left: 10px;
    }
    .tree-row-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tree-icon {
      font-size: 14px;
    }
    .tree-row.repo {
      color: var(--vscode-symbolIcon-moduleForeground, var(--vscode-foreground));
      padding: 4px 8px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-symbolIcon-moduleForeground, var(--vscode-focusBorder)) 10%, transparent);
    }
    .tree-row.worktree {
      color: var(--vscode-symbolIcon-folderForeground, var(--vscode-foreground));
      padding: 4px 8px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-symbolIcon-folderForeground, var(--vscode-focusBorder)) 8%, transparent);
    }
    .type-badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      border: 1px solid var(--vscode-panel-border);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.02em;
      padding: 1px 6px;
      white-space: nowrap;
      text-transform: uppercase;
    }
    .type-badge.repo {
      color: var(--vscode-symbolIcon-moduleForeground, var(--vscode-foreground));
      background: color-mix(in srgb, var(--vscode-symbolIcon-moduleForeground, var(--vscode-focusBorder)) 14%, transparent);
    }
    .type-badge.worktree {
      color: var(--vscode-symbolIcon-folderForeground, var(--vscode-foreground));
      background: color-mix(in srgb, var(--vscode-symbolIcon-folderForeground, var(--vscode-focusBorder)) 12%, transparent);
    }
    .tree-row-meta {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .tree-children {
      display: grid;
      gap: 8px;
    }
    .tree-comments {
      display: grid;
      gap: 8px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      border: 1px solid var(--vscode-panel-border);
      font-size: 11px;
      padding: 1px 8px;
      opacity: 0.9;
      white-space: nowrap;
    }
    .count-badge {
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      border-color: color-mix(in srgb, var(--vscode-badge-background) 70%, var(--vscode-panel-border));
      font-weight: 700;
      min-width: 36px;
      justify-content: center;
    }
    .code-line {
      display: block;
      white-space: pre;
    }
    .code-line-active {
      color: var(--vscode-editorInfo-foreground);
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="tabs">
    <button class="tab active" id="tab-pending">Pending</button>
    <button class="tab" id="tab-reviews">Resolved</button>
  </div>
  <section id="pending-list" class="list"></section>
  <section id="reviews-list" class="list hidden"></section>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = {
      pending: [],
      reviews: [],
      tab: "pending",
      expandedBatches: {},
      expandedRepos: {},
      expandedWorktrees: {},
      editingCommentId: null
    };

    const tabPending = document.getElementById("tab-pending");
    const tabReviews = document.getElementById("tab-reviews");
    const pendingList = document.getElementById("pending-list");
    const reviewsList = document.getElementById("reviews-list");

    function setTab(tab) {
      state.tab = tab;
      const pendingActive = tab === "pending";
      tabPending.classList.toggle("active", pendingActive);
      tabReviews.classList.toggle("active", !pendingActive);
      pendingList.classList.toggle("hidden", !pendingActive);
      reviewsList.classList.toggle("hidden", pendingActive);
    }

    tabPending.addEventListener("click", () => setTab("pending"));
    tabReviews.addEventListener("click", () => setTab("reviews"));

    function renderPending() {
      if (!state.pending.length) {
        pendingList.innerHTML = '<div class="empty">No pending comments yet. Use right click or Cmd/Ctrl+Alt+R in the editor.</div>';
        return;
      }
      const grouped = groupPending(state.pending);
      pendingList.innerHTML = grouped.map((repoGroup) => {
        const repoKey = repoGroup.repoKey;
        const repoOpen = state.expandedRepos[repoKey] ?? true;
        return \`
          <section class="tree-node">
            <button class="tree-row repo" data-toggle-repo="\${escapeHtml(repoKey)}" title="\${escapeHtml(repoGroup.repoPath || repoGroup.repoName)}">
              <span class="tree-row-label">
                <span>\${repoOpen ? "▾" : "▸"}</span>
                <span class="codicon codicon-repo tree-icon"></span>
                <span class="type-badge repo">Repo</span>
                <span class="tree-row-title">\${escapeHtml(repoGroup.repoName)}</span>
              </span>
              <span class="tree-row-meta">
                <span class="badge count-badge">\${formatCommentCount(repoGroup.count)}</span>
              </span>
            </button>
            <div class="\${repoOpen ? "tree-children" : "hidden"}">
              \${repoGroup.worktrees.map((worktreeGroup) => {
                const worktreeKey = \`\${repoKey}::\${worktreeGroup.worktreeName}\`;
                const worktreeOpen = state.expandedWorktrees[worktreeKey] ?? true;
                return \`
                  <section class="tree-node">
                    <button class="tree-row worktree" data-toggle-worktree="\${escapeHtml(worktreeKey)}">
                      <span class="tree-row-label worktree">
                        <span>\${worktreeOpen ? "▾" : "▸"}</span>
                        <span class="codicon codicon-git-branch tree-icon"></span>
                        <span class="tree-row-title">\${escapeHtml(worktreeGroup.worktreeName)}</span>
                      </span>
                      <span class="tree-row-meta">
                        \${worktreeGroup.isRootWorktree ? '<span class="badge">root</span>' : ""}
                        <span class="badge">\${escapeHtml(worktreeGroup.branchName)}</span>
                        <span class="badge count-badge">\${formatCommentCount(worktreeGroup.comments.length)}</span>
                      </span>
                    </button>
                    <div class="\${worktreeOpen ? "tree-comments" : "hidden"}">
                      <div class="worktree-actions">
                        <span class="claude-send-group" title="Claude Code (terminal)">
                          <span class="claude-icon-wrap" title="Sent via terminal for Claude Code" aria-hidden="true">
                            <img src="${claudeIconUri}" alt="" />
                          </span>
                          <button class="primary" data-send-worktree="\${escapeHtml(worktreeGroup.workspaceFolderPath)}" title="New terminal in this folder — paste for Claude Code">Send for review</button>
                          <button data-send-current-worktree="\${escapeHtml(worktreeGroup.workspaceFolderPath)}" title="Active terminal — paste for Claude Code">Current terminal</button>
                        </span>
                        <button data-clear-worktree="\${escapeHtml(worktreeGroup.workspaceFolderPath)}">Clear</button>
                      </div>
                      \${worktreeGroup.comments.map((comment) => renderCommentCard(comment)).join("")}
                    </div>
                  </section>
                \`;
              }).join("")}
            </div>
          </section>
        \`;
      }).join("");
      wireOpenButtons(pendingList);
    }

    function renderReviews() {
      if (!state.reviews.length) {
        reviewsList.innerHTML = '<div class="empty">No review batches yet.</div>';
        return;
      }

      reviewsList.innerHTML = state.reviews.map((batch) => {
        const expanded = Boolean(state.expandedBatches[batch.id]);
        return \`
          <article class="card">
            <div class="batch-title">Batch \${new Date(batch.createdAt).toLocaleString()}</div>
            <div class="summary">\${batch.comments.length} comment(s)</div>
            <div class="actions">
              <button data-roll="\${batch.id}">Rollback</button>
              <button data-expand="\${batch.id}">\${expanded ? "Hide details" : "Show details"}</button>
            </div>
            <div class="\${expanded ? "" : "hidden"}" id="details-\${batch.id}">
              \${batch.comments.map((comment) => renderCommentCard(comment)).join("")}
            </div>
          </article>
        \`;
      }).join("");

      reviewsList.querySelectorAll("[data-roll]").forEach((btn) => {
        btn.addEventListener("click", () => {
          vscode.postMessage({ type: "rollbackBatch", batchId: btn.getAttribute("data-roll") });
        });
      });
      reviewsList.querySelectorAll("[data-expand]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-expand");
          state.expandedBatches[id] = !state.expandedBatches[id];
          renderReviews();
        });
      });
      wireOpenButtons(reviewsList);
    }

    function renderCommentCard(comment) {
      const isEditing = state.editingCommentId === comment.id;
      return \`
        <article class="card">
          <div class="meta">
            <span></span>
            <span>\${new Date(comment.createdAt).toLocaleString()}</span>
          </div>
          <div class="path-row">
            <a class="path-link" data-open="\${comment.id}">\${escapeHtml(formatFileLineLabel(comment.relativePath, comment.line))}</a>
            <div class="actions">
              <button class="icon-btn" data-edit="\${comment.id}" title="Edit comment">
                <span class="codicon codicon-edit"></span>
              </button>
              <button class="icon-btn" data-delete="\${comment.id}" title="Delete comment">
                <span class="codicon codicon-trash"></span>
              </button>
            </div>
          </div>
          <div class="comment">\${escapeHtml(comment.comment)}</div>
          <pre class="code">\${renderContext(comment.context)}</pre>
          <div class="\${isEditing ? "editor-row" : "hidden"}">
            <textarea class="editor-input" data-editor="\${comment.id}">\${escapeHtml(comment.comment)}</textarea>
            <div class="actions">
              <button class="primary" data-save="\${comment.id}">Save</button>
            </div>
          </div>
        </article>
      \`;
    }

    function wireOpenButtons(root) {
      root.querySelectorAll("[data-toggle-repo]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.getAttribute("data-toggle-repo");
          state.expandedRepos[key] = !(state.expandedRepos[key] ?? true);
          renderPending();
        });
      });
      root.querySelectorAll("[data-toggle-worktree]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.getAttribute("data-toggle-worktree");
          state.expandedWorktrees[key] = !(state.expandedWorktrees[key] ?? true);
          renderPending();
        });
      });
      root.querySelectorAll("[data-open]").forEach((btn) => {
        btn.addEventListener("click", () => {
          vscode.postMessage({ type: "openComment", commentId: btn.getAttribute("data-open") });
        });
      });
      root.querySelectorAll("[data-edit]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const commentId = btn.getAttribute("data-edit");
          state.editingCommentId = state.editingCommentId === commentId ? null : commentId;
          renderPending();
          renderReviews();
        });
      });
      root.querySelectorAll("[data-save]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const commentId = btn.getAttribute("data-save");
          const input = root.querySelector(\`[data-editor="\${commentId}"]\`);
          if (!input) {
            return;
          }
          const next = input.value ?? "";
          vscode.postMessage({ type: "updateComment", commentId, commentText: next });
          state.editingCommentId = null;
        });
      });
      root.querySelectorAll("[data-delete]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const commentId = btn.getAttribute("data-delete");
          state.editingCommentId = state.editingCommentId === commentId ? null : state.editingCommentId;
          vscode.postMessage({ type: "deleteComment", commentId });
        });
      });
      root.querySelectorAll("[data-send-worktree]").forEach((btn) => {
        btn.addEventListener("click", () => {
          vscode.postMessage({
            type: "sendForReviewWorktree",
            workspaceFolderPath: btn.getAttribute("data-send-worktree"),
          });
        });
      });
      root.querySelectorAll("[data-send-current-worktree]").forEach((btn) => {
        btn.addEventListener("click", () => {
          vscode.postMessage({
            type: "sendInCurrentTerminalWorktree",
            workspaceFolderPath: btn.getAttribute("data-send-current-worktree"),
          });
        });
      });
      root.querySelectorAll("[data-clear-worktree]").forEach((btn) => {
        btn.addEventListener("click", () => {
          vscode.postMessage({
            type: "clearPendingWorktree",
            workspaceFolderPath: btn.getAttribute("data-clear-worktree"),
          });
        });
      });
    }

    function escapeHtml(text) {
      return String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function groupPending(comments) {
      const repoMap = new Map();
      for (const comment of comments) {
        const repoPath = comment.repoPath || "";
        const repoKey = repoPath || comment.repoName || "Unknown Repo";
        const repoName = comment.repoName || "Unknown Repo";
        const worktreeName = comment.worktreeName || "Unknown Worktree";
        const repoGroup =
          repoMap.get(repoKey) || { repoKey, repoName, repoPath, count: 0, worktreeMap: new Map() };
        repoGroup.count += 1;
        const worktreeGroup =
          repoGroup.worktreeMap.get(worktreeName) ||
          {
            worktreeName,
            workspaceFolderPath: comment.workspaceFolderPath,
            branchName: comment.branchName || "unknown",
            isRootWorktree: worktreeName === repoName,
            comments: [],
          };
        worktreeGroup.comments.push(comment);
        repoGroup.worktreeMap.set(worktreeName, worktreeGroup);
        repoMap.set(repoKey, repoGroup);
      }

      return Array.from(repoMap.values()).map((repoGroup) => ({
        repoKey: repoGroup.repoKey,
        repoName: repoGroup.repoName,
        repoPath: repoGroup.repoPath,
        count: repoGroup.count,
        worktrees: Array.from(repoGroup.worktreeMap.values()),
      }));
    }

    function renderContext(lines) {
      return lines
        .map((line) => {
          const escaped = escapeHtml(line);
          const active = line.trim().startsWith(">");
          return \`<span class="code-line \${active ? "code-line-active" : ""}">\${escaped}</span>\`;
        })
        .join("");
    }

    function formatFileLineLabel(relativePath, line) {
      const fileName = String(relativePath || "")
        .split(/[\\\\/]/)
        .filter(Boolean)
        .pop() || String(relativePath || "unknown");
      return \`\${fileName}:L\${line}\`;
    }

    function formatCommentCount(count) {
      const safeCount = Number(count) || 0;
      return safeCount > 99 ? "99+" : String(safeCount);
    }

    window.addEventListener("message", (event) => {
      if (event.data?.type === "state") {
        state.pending = event.data.state.pending ?? [];
        state.reviews = event.data.state.reviews ?? [];
        renderPending();
        renderReviews();
      }
    });

    setTab("pending");
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}
function deactivate() {
    // no-op
}
//# sourceMappingURL=extension.js.map