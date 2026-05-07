import * as vscode from "vscode";
import * as path from "node:path";
import type { ReviewComment } from "./types";
import type { ReviewStore } from "./store";

export type PendingTreeItem = RepoNode | WorktreeNode | FileNode;

export class RepoNode {
  readonly kind = "repo" as const;
  constructor(
    readonly repoKey: string,
    readonly repoName: string,
    readonly repoPath: string,
    readonly count: number,
    readonly worktrees: WorktreeNode[]
  ) {}
}

export class WorktreeNode {
  readonly kind = "worktree" as const;
  constructor(
    readonly worktreeKey: string,
    readonly worktreeName: string,
    readonly branchName: string,
    readonly workspaceFolderPath: string,
    readonly isRootWorktree: boolean,
    readonly files: FileNode[]
  ) {}
}

export class FileNode {
  readonly kind = "file" as const;
  constructor(
    readonly filePath: string,
    readonly relativePath: string,
    readonly count: number,
    readonly workspaceFolderPath: string
  ) {}
}

export class PendingTreeProvider implements vscode.TreeDataProvider<PendingTreeItem> {
  private readonly emitter = new vscode.EventEmitter<PendingTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly store: ReviewStore) {
    this.subscriptions.push(this.store.onDidChange(() => this.emitter.fire()));
    this.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.emitter.fire())
    );
  }

  dispose(): void {
    vscode.Disposable.from(...this.subscriptions).dispose();
    this.emitter.dispose();
  }

  getTreeItem(element: PendingTreeItem): vscode.TreeItem {
    switch (element.kind) {
      case "repo":
        return repoTreeItem(element);
      case "worktree":
        return worktreeTreeItem(element);
      case "file":
        return fileTreeItem(element);
    }
  }

  getChildren(element?: PendingTreeItem): PendingTreeItem[] {
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

  private buildRepoNodes(): RepoNode[] {
    const visibleFolders = new Set(
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)
    );
    const pending = this.store
      .getActivePending()
      .filter((c) => visibleFolders.size === 0 || visibleFolders.has(c.workspaceFolderPath));

    const repoMap = new Map<
      string,
      {
        repoKey: string;
        repoName: string;
        repoPath: string;
        count: number;
        worktreeMap: Map<
          string,
          {
            worktreeName: string;
            branchName: string;
            workspaceFolderPath: string;
            isRootWorktree: boolean;
            fileMap: Map<string, { relativePath: string; count: number }>;
          }
        >;
      }
    >();

    for (const c of pending) {
      const repoPath = c.repoPath || "";
      const repoKey = repoPath || c.repoName || "Unknown Repo";
      const repoEntry =
        repoMap.get(repoKey) ??
        {
          repoKey,
          repoName: c.repoName || "Unknown Repo",
          repoPath,
          count: 0,
          worktreeMap: new Map(),
        };
      repoEntry.count += 1;

      const worktreeName = c.worktreeName || "Unknown Worktree";
      const worktreeEntry =
        repoEntry.worktreeMap.get(worktreeName) ??
        {
          worktreeName,
          branchName: c.branchName || "unknown",
          workspaceFolderPath: c.workspaceFolderPath,
          isRootWorktree: worktreeName === repoEntry.repoName,
          fileMap: new Map<string, { relativePath: string; count: number }>(),
        };

      const fileEntry =
        worktreeEntry.fileMap.get(c.filePath) ??
        { relativePath: c.relativePath, count: 0 };
      fileEntry.count += 1;
      worktreeEntry.fileMap.set(c.filePath, fileEntry);

      repoEntry.worktreeMap.set(worktreeName, worktreeEntry);
      repoMap.set(repoKey, repoEntry);
    }

    return Array.from(repoMap.values()).map((repo) => {
      const worktrees = Array.from(repo.worktreeMap.values()).map((w) => {
        const files = Array.from(w.fileMap.entries()).map(
          ([fp, info]) =>
            new FileNode(fp, info.relativePath, info.count, w.workspaceFolderPath)
        );
        files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        return new WorktreeNode(
          `${repo.repoKey}::${w.worktreeName}`,
          w.worktreeName,
          w.branchName,
          w.workspaceFolderPath,
          w.isRootWorktree,
          files
        );
      });
      worktrees.sort((a, b) => a.worktreeName.localeCompare(b.worktreeName));
      return new RepoNode(repo.repoKey, repo.repoName, repo.repoPath, repo.count, worktrees);
    });
  }
}

function repoTreeItem(node: RepoNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.repoName, vscode.TreeItemCollapsibleState.Expanded);
  item.iconPath = new vscode.ThemeIcon("repo");
  item.description = formatCount(node.count);
  item.tooltip = node.repoPath || node.repoName;
  item.contextValue = "codeReview.repo";
  return item;
}

function worktreeTreeItem(node: WorktreeNode): vscode.TreeItem {
  const fileCount = node.files.reduce((acc, f) => acc + f.count, 0);
  const item = new vscode.TreeItem(node.worktreeName, vscode.TreeItemCollapsibleState.Expanded);
  item.iconPath = new vscode.ThemeIcon("git-branch");
  item.description = `${node.branchName} · ${formatCount(fileCount)}`;
  item.tooltip = `${node.worktreeName} on ${node.branchName}\n${node.workspaceFolderPath}`;
  item.contextValue = node.isRootWorktree ? "codeReview.worktree.root" : "codeReview.worktree";
  return item;
}

function fileTreeItem(node: FileNode): vscode.TreeItem {
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

function formatCount(n: number): string {
  return n === 1 ? "1 comment" : `${n} comments`;
}

function formatDirSegment(relative: string, fileName: string): string {
  const dir = relative.endsWith(fileName) ? relative.slice(0, -fileName.length) : relative;
  return dir.replace(/[\\/]+$/, "");
}
