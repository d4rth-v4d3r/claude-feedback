"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BatchFileNode = exports.BatchNode = exports.FileNode = exports.WorktreeNode = exports.RepoNode = void 0;
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const node_child_process_1 = require("node:child_process");
const store_1 = require("./store");
const reviewCommentsController_1 = require("./reviewCommentsController");
const parentBranchResolver_1 = require("./parentBranchResolver");
const diffOpener_1 = require("./diffOpener");
const pendingTreeProvider_1 = require("./pendingTreeProvider");
Object.defineProperty(exports, "RepoNode", { enumerable: true, get: function () { return pendingTreeProvider_1.RepoNode; } });
Object.defineProperty(exports, "WorktreeNode", { enumerable: true, get: function () { return pendingTreeProvider_1.WorktreeNode; } });
Object.defineProperty(exports, "FileNode", { enumerable: true, get: function () { return pendingTreeProvider_1.FileNode; } });
const resolvedTreeProvider_1 = require("./resolvedTreeProvider");
Object.defineProperty(exports, "BatchNode", { enumerable: true, get: function () { return resolvedTreeProvider_1.BatchNode; } });
Object.defineProperty(exports, "BatchFileNode", { enumerable: true, get: function () { return resolvedTreeProvider_1.BatchFileNode; } });
const CLAUDE_TUI_SETTLE_MS = 2800;
const CLAUDE_LAUNCH_DETECT_MS = 14000;
const CLAUDE_FALLBACK_PASTE_DELAY_MS = 3800;
function activate(context) {
    const store = new store_1.ReviewStore(context);
    const locator = new LocationMetadataResolver();
    const parentResolver = new parentBranchResolver_1.ParentBranchResolver();
    const commentsController = new reviewCommentsController_1.ReviewCommentsController(store, async (uri, line, body) => {
        await addCommentForUriAndLine(store, locator, uri, line, body);
    });
    const pendingTree = new pendingTreeProvider_1.PendingTreeProvider(store);
    const resolvedTree = new resolvedTreeProvider_1.ResolvedTreeProvider(store);
    context.subscriptions.push(commentsController, pendingTree, resolvedTree);
    context.subscriptions.push(vscode.window.registerTreeDataProvider("codeReviewPending", pendingTree), vscode.window.registerTreeDataProvider("codeReviewResolved", resolvedTree));
    // --- Commands ---
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.openSidebar", async () => {
        await vscode.commands.executeCommand("workbench.view.extension.codeReviewContainer");
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.addComment", async () => {
        await addCommentFromActiveEditor(store, locator);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.openFileDiff", async (uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) {
            return;
        }
        await (0, diffOpener_1.openFileDiffVsParent)(target, parentResolver);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.replyComment", async (reply) => {
        await commentsController.handleReply(reply);
    }));
    // Same handler — separate command id so the empty-thread submit button
    // can read "Comment" instead of "Reply" via `commentThreadIsEmpty`.
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.startThread", async (reply) => {
        await commentsController.handleReply(reply);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.editComment", async (comment) => {
        if (!(0, reviewCommentsController_1.isReviewComment)(comment)) {
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
        await commentsController.editMessage(comment.reviewCommentId, comment.reviewMessageId, next);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.deleteComment", async (comment) => {
        if (!(0, reviewCommentsController_1.isReviewComment)(comment)) {
            return;
        }
        await commentsController.deleteMessage(comment.reviewCommentId, comment.reviewMessageId);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.deleteThread", async (thread) => {
        const first = thread.comments[0];
        if (first && (0, reviewCommentsController_1.isReviewComment)(first)) {
            await commentsController.deleteThread(first.reviewCommentId);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.toggleResolved", async (thread) => {
        const first = thread.comments[0];
        if (first && (0, reviewCommentsController_1.isReviewComment)(first)) {
            await commentsController.toggleResolved(first.reviewCommentId);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.setParentBranch", async (target) => {
        await setParentBranchInteractive(parentResolver, target);
    }));
    // --- Send / clear / rollback (preserve existing UX) ---
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.sendForReview", async (target) => {
        await sendForReview(store, locator, target?.workspaceFolderPath);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.sendInCurrentTerminal", async (target) => {
        await sendInCurrentTerminal(store, target?.workspaceFolderPath);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.clearPending", async (target) => {
        await clearPending(store, target?.workspaceFolderPath);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.rollbackBatch", async (node) => {
        const batchId = node?.batch.id;
        if (!batchId) {
            return;
        }
        await rollbackBatch(store, batchId);
    }));
    // Keyboard quick-access menu (kept for compat with existing keybinding)
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.quickReviewMenu", async () => {
        const picked = await vscode.window.showQuickPick([
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
        ], { placeHolder: "Choose an action", title: "Code review", ignoreFocusOut: true });
        if (!picked) {
            return;
        }
        if (picked.action === "add") {
            await vscode.commands.executeCommand("codeReview.addComment");
        }
        else if (picked.action === "diff") {
            await vscode.commands.executeCommand("codeReview.openFileDiff");
        }
        else {
            await vscode.commands.executeCommand("codeReview.openSidebar");
        }
    }));
}
function deactivate() {
    // no-op
}
// ---------- Adding comments ----------
async function addCommentFromActiveEditor(store, locator) {
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
async function addCommentForUriAndLine(store, locator, uri, line1Based, body) {
    if (uri.scheme !== "file") {
        return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    await persistNewComment(store, locator, document, line1Based, body);
}
async function persistNewComment(store, locator, document, line1Based, body) {
    const text = body.trim();
    if (!text) {
        return;
    }
    const lineIndex = Math.max(0, Math.min(line1Based - 1, document.lineCount - 1));
    const contextLines = readContext(document, lineIndex);
    const metadata = locator.getLocationMetadata(document.uri);
    const id = makeId();
    const message = {
        id: `${id}-m0`,
        author: "You",
        body: text,
        createdAt: new Date().toISOString(),
    };
    const newComment = {
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
function readContext(document, lineIndex) {
    const start = Math.max(lineIndex - 2, 0);
    const end = Math.min(lineIndex + 2, document.lineCount - 1);
    const lines = [];
    for (let i = start; i <= end; i += 1) {
        const marker = i === lineIndex ? ">" : " ";
        lines.push(`${marker} L${i + 1}: ${document.lineAt(i).text}`);
    }
    return lines;
}
// ---------- Send / clear / rollback ----------
async function clearPending(store, workspaceFolderPath) {
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
async function rollbackBatch(store, batchId) {
    await store.update((state) => {
        const idx = state.reviews.findIndex((b) => b.id === batchId);
        if (idx < 0) {
            return;
        }
        const [batch] = state.reviews.splice(idx, 1);
        state.pending = [...batch.comments, ...state.pending];
    });
}
async function sendForReview(store, locator, workspaceFolderPath) {
    const targetComments = getTargetCommentsForSend(store, workspaceFolderPath);
    if (!targetComments.length) {
        vscode.window.showWarningMessage("No pending review comments to send.");
        return;
    }
    const cwd = resolveSendCwd(workspaceFolderPath, targetComments);
    if (!cwd) {
        vscode.window.showWarningMessage("Pending comments span multiple workspace folders. Send from a worktree node in the Code Review sidebar.");
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
        vscode.window.showWarningMessage("Claude did not report as started in time; pasted anyway. If zsh ran part of the review text, paste from the clipboard after Claude is ready.");
    }
    sendReviewTextToTerminal(terminal, copiedText);
    vscode.window.showInformationMessage("Review saved; Claude started in this worktree and review text pasted (clipboard updated).");
}
async function sendInCurrentTerminal(store, workspaceFolderPath) {
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
        vscode.window.showWarningMessage("Pending comments span multiple workspace folders. Send from a worktree node in the Code Review sidebar.");
        return;
    }
    const copiedText = buildReviewCopyText(targetComments);
    await vscode.env.clipboard.writeText(copiedText);
    await commitReviewBatch(store, targetComments, copiedText, workspaceFolderPath);
    sendReviewTextToTerminal(active, copiedText);
    vscode.window.showInformationMessage("Review saved; pasted into active terminal for Claude Code (clipboard updated).");
}
function getTargetCommentsForSend(store, workspaceFolderPath) {
    const active = store.getActivePending();
    return workspaceFolderPath
        ? active.filter((c) => c.workspaceFolderPath === workspaceFolderPath)
        : active;
}
function resolveSendCwd(workspaceFolderPath, targetComments) {
    if (workspaceFolderPath) {
        return workspaceFolderPath;
    }
    const folders = [...new Set(targetComments.map((c) => c.workspaceFolderPath))];
    return folders.length === 1 ? folders[0] : undefined;
}
async function commitReviewBatch(store, targetComments, copiedText, workspaceFolderPath) {
    const idsToRemove = new Set(targetComments.map((c) => c.id));
    const batch = {
        id: makeId(),
        createdAt: new Date().toISOString(),
        comments: [...targetComments],
        copiedText,
    };
    await store.update((state) => {
        state.reviews = [batch, ...state.reviews];
        state.pending = workspaceFolderPath
            ? state.pending.filter((c) => c.workspaceFolderPath !== workspaceFolderPath || !idsToRemove.has(c.id))
            : state.pending.filter((c) => !idsToRemove.has(c.id));
    });
}
// ---------- Parent branch interactive setter ----------
async function setParentBranchInteractive(resolver, target) {
    let probeUri;
    if (target instanceof vscode.Uri) {
        probeUri = target;
    }
    else if (target && "workspaceFolderPath" in target) {
        probeUri = vscode.Uri.file(target.workspaceFolderPath);
    }
    else {
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
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function resolveClaudeTerminalLocation() {
    const loc = vscode.workspace.getConfiguration("codeReview").get("claudeTerminalLocation", "editor");
    if (loc === "panel") {
        return vscode.TerminalLocation.Panel;
    }
    const viewColumn = vscode.window.activeTextEditor?.viewColumn ??
        vscode.window.tabGroups.activeTabGroup?.viewColumn ??
        vscode.ViewColumn.One;
    return { viewColumn, preserveFocus: false };
}
async function waitForShellIntegrationReady(terminal, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (terminal.shellIntegration) {
            return;
        }
        await sleep(80);
    }
}
function commandLineLooksLikeClaudeLaunch(commandLine) {
    const t = commandLine.trim().toLowerCase();
    if (!t.length) {
        return false;
    }
    if (/\bclaude\b/.test(t)) {
        return true;
    }
    return t.includes("claude-code") || t.includes("@anthropic/claude") || t.includes("anthropic.claude");
}
function waitForClaudeShellLaunch(terminal, timeoutMs) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok) => {
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
            }
            catch {
                // commandLine may be incomplete in rare cases
            }
        });
        const timer = setTimeout(() => finish(false), timeoutMs);
    });
}
function makeId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
function buildReviewCopyText(comments) {
    const lines = comments.map((item, index) => `  ${index + 1}. @${item.filePath} L${item.line}: ${formatBodyForLine((0, store_1.commentBodyForSend)(item))}`);
    return [
        "Please address the following code review comments. Run git diff (or git diff HEAD) to see the full context of any changes, especially for deleted lines.",
        "",
        ...lines,
    ].join("\n");
}
function formatBodyForLine(body) {
    return body.replace(/\r?\n/g, "\n     ");
}
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
function sendReviewTextToTerminal(terminal, text) {
    const safe = text.replace(/\u001b/g, "");
    terminal.sendText(BRACKETED_PASTE_START + safe + BRACKETED_PASTE_END, false);
}
class LocationMetadataResolver {
    constructor() {
        this.branchCache = new Map();
    }
    getLocationMetadata(uri) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        const workspaceFolderPath = workspaceFolder?.uri.fsPath ?? path.dirname(uri.fsPath);
        const discoveredRepoPath = this.findGitRoot(path.dirname(uri.fsPath)) ?? workspaceFolderPath;
        const gitIdentity = this.getGitIdentity(discoveredRepoPath);
        const relativePath = path.relative(gitIdentity.worktreeRootPath, uri.fsPath) || path.basename(uri.fsPath);
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
//# sourceMappingURL=extension.js.map