"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PendingTreeProvider = exports.FileNode = exports.WorktreeNode = exports.RepoNode = void 0;
const vscode = require("vscode");
const path = require("node:path");
class RepoNode {
    constructor(repoKey, repoName, repoPath, count, worktrees) {
        this.repoKey = repoKey;
        this.repoName = repoName;
        this.repoPath = repoPath;
        this.count = count;
        this.worktrees = worktrees;
        this.kind = "repo";
    }
}
exports.RepoNode = RepoNode;
class WorktreeNode {
    constructor(worktreeKey, worktreeName, branchName, workspaceFolderPath, isRootWorktree, files) {
        this.worktreeKey = worktreeKey;
        this.worktreeName = worktreeName;
        this.branchName = branchName;
        this.workspaceFolderPath = workspaceFolderPath;
        this.isRootWorktree = isRootWorktree;
        this.files = files;
        this.kind = "worktree";
    }
}
exports.WorktreeNode = WorktreeNode;
class FileNode {
    constructor(filePath, relativePath, count, workspaceFolderPath) {
        this.filePath = filePath;
        this.relativePath = relativePath;
        this.count = count;
        this.workspaceFolderPath = workspaceFolderPath;
        this.kind = "file";
    }
}
exports.FileNode = FileNode;
class PendingTreeProvider {
    constructor(store) {
        this.store = store;
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.emitter.event;
        this.subscriptions = [];
        this.subscriptions.push(this.store.onDidChange(() => this.emitter.fire()));
        this.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.emitter.fire()));
    }
    dispose() {
        vscode.Disposable.from(...this.subscriptions).dispose();
        this.emitter.dispose();
    }
    getTreeItem(element) {
        switch (element.kind) {
            case "repo":
                return repoTreeItem(element);
            case "worktree":
                return worktreeTreeItem(element);
            case "file":
                return fileTreeItem(element);
        }
    }
    getChildren(element) {
        if (!element) {
            return this.buildRepoNodes();
        }
        if (element.kind === "repo") {
            return element.worktrees;
        }
        if (element.kind === "worktree") {
            return element.files;
        }
        return [];
    }
    buildRepoNodes() {
        const visibleFolders = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
        const pending = this.store
            .getActivePending()
            .filter((c) => visibleFolders.size === 0 || visibleFolders.has(c.workspaceFolderPath));
        const repoMap = new Map();
        for (const c of pending) {
            const repoPath = c.repoPath || "";
            const repoKey = repoPath || c.repoName || "Unknown Repo";
            const repoEntry = repoMap.get(repoKey) ??
                {
                    repoKey,
                    repoName: c.repoName || "Unknown Repo",
                    repoPath,
                    count: 0,
                    worktreeMap: new Map(),
                };
            repoEntry.count += 1;
            const worktreeName = c.worktreeName || "Unknown Worktree";
            const worktreeEntry = repoEntry.worktreeMap.get(worktreeName) ??
                {
                    worktreeName,
                    branchName: c.branchName || "unknown",
                    workspaceFolderPath: c.workspaceFolderPath,
                    isRootWorktree: worktreeName === repoEntry.repoName,
                    fileMap: new Map(),
                };
            const fileEntry = worktreeEntry.fileMap.get(c.filePath) ??
                { relativePath: c.relativePath, count: 0 };
            fileEntry.count += 1;
            worktreeEntry.fileMap.set(c.filePath, fileEntry);
            repoEntry.worktreeMap.set(worktreeName, worktreeEntry);
            repoMap.set(repoKey, repoEntry);
        }
        return Array.from(repoMap.values()).map((repo) => {
            const worktrees = Array.from(repo.worktreeMap.values()).map((w) => {
                const files = Array.from(w.fileMap.entries()).map(([fp, info]) => new FileNode(fp, info.relativePath, info.count, w.workspaceFolderPath));
                files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
                return new WorktreeNode(`${repo.repoKey}::${w.worktreeName}`, w.worktreeName, w.branchName, w.workspaceFolderPath, w.isRootWorktree, files);
            });
            worktrees.sort((a, b) => a.worktreeName.localeCompare(b.worktreeName));
            return new RepoNode(repo.repoKey, repo.repoName, repo.repoPath, repo.count, worktrees);
        });
    }
}
exports.PendingTreeProvider = PendingTreeProvider;
function repoTreeItem(node) {
    const item = new vscode.TreeItem(node.repoName, vscode.TreeItemCollapsibleState.Expanded);
    item.iconPath = new vscode.ThemeIcon("repo");
    item.description = formatCount(node.count);
    item.tooltip = node.repoPath || node.repoName;
    item.contextValue = "codeReview.repo";
    return item;
}
function worktreeTreeItem(node) {
    const fileCount = node.files.reduce((acc, f) => acc + f.count, 0);
    const item = new vscode.TreeItem(node.worktreeName, vscode.TreeItemCollapsibleState.Expanded);
    item.iconPath = new vscode.ThemeIcon("git-branch");
    item.description = `${node.branchName} · ${formatCount(fileCount)}`;
    item.tooltip = `${node.worktreeName} on ${node.branchName}\n${node.workspaceFolderPath}`;
    item.contextValue = node.isRootWorktree ? "codeReview.worktree.root" : "codeReview.worktree";
    return item;
}
function fileTreeItem(node) {
    const fileName = path.basename(node.filePath);
    const item = new vscode.TreeItem(fileName, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = vscode.Uri.file(node.filePath);
    item.description = node.relativePath !== fileName ? formatDirSegment(node.relativePath, fileName) : undefined;
    item.tooltip = `${node.relativePath} · ${formatCount(node.count)}`;
    item.contextValue = "codeReview.file";
    item.command = {
        command: "codeReview.openFileDiff",
        title: "Open Diff vs Parent Branch",
        arguments: [vscode.Uri.file(node.filePath)],
    };
    return item;
}
function formatCount(n) {
    return n === 1 ? "1 comment" : `${n} comments`;
}
function formatDirSegment(relative, fileName) {
    const dir = relative.endsWith(fileName) ? relative.slice(0, -fileName.length) : relative;
    return dir.replace(/[\\/]+$/, "");
}
//# sourceMappingURL=pendingTreeProvider.js.map