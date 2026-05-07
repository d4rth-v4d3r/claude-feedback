"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PendingTreeProvider = exports.FileNode = exports.DirectoryNode = exports.WorktreeNode = exports.RepoNode = void 0;
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
    constructor(worktreeKey, worktreeName, branchName, workspaceFolderPath, isRootWorktree, 
    /** Top-level children of the worktree root: directories and any files at the root. */
    children) {
        this.worktreeKey = worktreeKey;
        this.worktreeName = worktreeName;
        this.branchName = branchName;
        this.workspaceFolderPath = workspaceFolderPath;
        this.isRootWorktree = isRootWorktree;
        this.children = children;
        this.kind = "worktree";
    }
}
exports.WorktreeNode = WorktreeNode;
class DirectoryNode {
    constructor(
    /** Display label, e.g. "packages/restaurant-ui" when single-child chains are compacted. */
    label, 
    /** Path relative to the worktree root, used as the stable tree id. */
    relativePath, count, children) {
        this.label = label;
        this.relativePath = relativePath;
        this.count = count;
        this.children = children;
        this.kind = "directory";
    }
}
exports.DirectoryNode = DirectoryNode;
class FileNode {
    constructor(filePath, 
    /** Path relative to the worktree root. */
    relativePath, count, workspaceFolderPath) {
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
            case "directory":
                return directoryTreeItem(element);
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
            return element.children;
        }
        if (element.kind === "directory") {
            return element.children;
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
                    comments: [],
                };
            worktreeEntry.comments.push(c);
            repoEntry.worktreeMap.set(worktreeName, worktreeEntry);
            repoMap.set(repoKey, repoEntry);
        }
        const compactFolders = vscode.workspace
            .getConfiguration("codeReview")
            .get("compactFolders", true);
        return Array.from(repoMap.values()).map((repo) => {
            const worktrees = Array.from(repo.worktreeMap.values()).map((w) => {
                const dirEntry = buildDirEntry(w.comments);
                const children = toTreeChildren(dirEntry, "", w.workspaceFolderPath, compactFolders);
                return new WorktreeNode(`${repo.repoKey}::${w.worktreeName}`, w.worktreeName, w.branchName, w.workspaceFolderPath, w.isRootWorktree, children);
            });
            worktrees.sort((a, b) => a.worktreeName.localeCompare(b.worktreeName));
            return new RepoNode(repo.repoKey, repo.repoName, repo.repoPath, repo.count, worktrees);
        });
    }
}
exports.PendingTreeProvider = PendingTreeProvider;
function buildDirEntry(comments) {
    const root = { dirs: new Map(), files: new Map() };
    for (const c of comments) {
        const segments = (c.relativePath || "").split(/[\\/]+/).filter(Boolean);
        if (segments.length === 0) {
            continue;
        }
        const fileName = segments.pop();
        let cursor = root;
        for (const seg of segments) {
            let next = cursor.dirs.get(seg);
            if (!next) {
                next = { dirs: new Map(), files: new Map() };
                cursor.dirs.set(seg, next);
            }
            cursor = next;
        }
        const existing = cursor.files.get(fileName);
        if (existing) {
            existing.count += 1;
        }
        else {
            cursor.files.set(fileName, { filePath: c.filePath, count: 1 });
        }
    }
    return root;
}
function toTreeChildren(entry, parentRelative, workspaceFolderPath, compact) {
    const out = [];
    const dirNames = Array.from(entry.dirs.keys()).sort((a, b) => a.localeCompare(b));
    for (const name of dirNames) {
        let cursor = entry.dirs.get(name);
        const labelSegments = [name];
        const relSegments = parentRelative ? [parentRelative, name] : [name];
        if (compact) {
            while (cursor.dirs.size === 1 && cursor.files.size === 0) {
                const onlyName = cursor.dirs.keys().next().value;
                labelSegments.push(onlyName);
                relSegments.push(onlyName);
                cursor = cursor.dirs.get(onlyName);
            }
        }
        const label = labelSegments.join("/");
        const relPath = relSegments.join("/");
        const childCount = countComments(cursor);
        const children = toTreeChildren(cursor, relPath, workspaceFolderPath, compact);
        out.push(new DirectoryNode(label, relPath, childCount, children));
    }
    const fileNames = Array.from(entry.files.keys()).sort((a, b) => a.localeCompare(b));
    for (const name of fileNames) {
        const info = entry.files.get(name);
        const relPath = parentRelative ? `${parentRelative}/${name}` : name;
        out.push(new FileNode(info.filePath, relPath, info.count, workspaceFolderPath));
    }
    return out;
}
function countComments(entry) {
    let total = 0;
    for (const f of entry.files.values()) {
        total += f.count;
    }
    for (const d of entry.dirs.values()) {
        total += countComments(d);
    }
    return total;
}
// ---------- Tree item renderers ----------
function repoTreeItem(node) {
    const item = new vscode.TreeItem(node.repoName, vscode.TreeItemCollapsibleState.Expanded);
    item.iconPath = new vscode.ThemeIcon("repo");
    item.description = formatCount(node.count);
    item.tooltip = node.repoPath || node.repoName;
    item.contextValue = "codeReview.repo";
    return item;
}
function worktreeTreeItem(node) {
    const total = sumChildCounts(node.children);
    const item = new vscode.TreeItem(node.worktreeName, vscode.TreeItemCollapsibleState.Expanded);
    item.iconPath = new vscode.ThemeIcon("git-branch");
    item.description = `${node.branchName} · ${formatCount(total)}`;
    item.tooltip = `${node.worktreeName} on ${node.branchName}\n${node.workspaceFolderPath}`;
    item.contextValue = node.isRootWorktree ? "codeReview.worktree.root" : "codeReview.worktree";
    return item;
}
function sumChildCounts(children) {
    let total = 0;
    for (const child of children) {
        total += child.count;
    }
    return total;
}
function directoryTreeItem(node) {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
    item.iconPath = vscode.ThemeIcon.Folder;
    item.description = formatCount(node.count);
    item.tooltip = node.relativePath;
    item.contextValue = "codeReview.directory";
    item.id = `dir::${node.relativePath}`;
    return item;
}
function fileTreeItem(node) {
    const fileName = path.basename(node.filePath);
    const item = new vscode.TreeItem(fileName, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = vscode.Uri.file(node.filePath);
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
//# sourceMappingURL=pendingTreeProvider.js.map