# Claude Feedback

Collect line-level code review comments from the editor, keep them in a sidebar, and copy a formatted batch for async review.

## Features

- Add a comment from the editor context menu: `Code Review: Add Comment Here`
- Keyboard shortcut:
  - macOS: `Cmd+Alt+R`
  - Linux/Windows: `Ctrl+Alt+R`
- Sidebar with two tabs:
  - `Pending`: editable working set before sending
  - `Reviews`: previously sent batches with rollback support
- Each card shows:
  - file path
  - target line
  - comment text
  - nearby code context
  - `Go to code` button
- Fixed bottom actions (Pending tab):
  - `Send for review` (copies text + archives batch)
  - `Clear` (removes all pending comments)

## Copied output format

```text
Please address the following code review comments. Run `git diff` (or `git diff HEAD`) to see the full context of any changes, especially for deleted lines.

  - @/absolute/path/to/file.ts L42: This should handle empty values.
```

## Development

```bash
npm install
npm run build
```

Open this folder in Cursor/VS Code and run the extension using the Extension Development Host.
