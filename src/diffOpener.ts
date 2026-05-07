import * as vscode from "vscode";
import * as path from "node:path";
import { getGitApi } from "./gitTypes";
import type { ParentBranchResolver } from "./parentBranchResolver";

/**
 * Opens `vscode.diff(parent@mergeBase, workingTree)` for `fileUri`. The
 * working-tree side is the live file, so any review CommentThreads we
 * created are anchored on the right side of the diff for free.
 *
 * If we can't compute a merge-base (e.g. the file is outside any repo, or
 * `origin/HEAD` is unset and no override is configured), we fall back to
 * just opening the file.
 */
export async function openFileDiffVsParent(
  fileUri: vscode.Uri,
  resolver: ParentBranchResolver
): Promise<void> {
  const parent = await resolver.resolve(fileUri);
  if (!parent) {
    await vscode.window.showTextDocument(fileUri, { preview: false });
    return;
  }

  const git = await getGitApi();
  if (!git) {
    await vscode.window.showTextDocument(fileUri, { preview: false });
    return;
  }

  const leftUri = git.toGitUri(fileUri, parent.mergeBaseSha);
  const baseName = path.basename(fileUri.fsPath);
  const shortRef = parent.parentRef.replace(/^refs\/(heads|remotes)\//, "");
  const title = `${baseName} (${shortRef} ↔ ${parent.branchName})`;

  await vscode.commands.executeCommand("vscode.diff", leftUri, fileUri, title, {
    preview: false,
  } satisfies vscode.TextDocumentShowOptions);
}
