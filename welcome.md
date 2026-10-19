# A little less mouse.

A Markdown workspace with **Vim at your fingertips**.
Make yourself at home: press `i`, change a line, then `Esc`.

> Your words stay local. Drafts are recovered automatically.
> Write to the file with `:w` or **Cmd/Ctrl + S**.

## Find your rhythm

| Intent | Keys |
| --- | --- |
| Move through words | `w` · `b` · `e` |
| Change the inner word | `ciw` |
| Select a line | `V` |
| Yank, then paste | `yy` · `p` |
| Undo / redo | `u` · `Ctrl+r` |
| Search the document | `/` |

## A small checklist

- [x] Normal, insert, and visual modes
- [x] Markdown source with a live preview
- [x] Explicit, conflict-aware saving
- [ ] Write something worth keeping

## Leave a note

Start here. This is a real, editable Markdown file in your
user extension's artifacts folder, not a temporary mockup.

```js
const idea = "Keep the writing close to the conversation.";
```

---

**The fine print:** this is CodeMirror with Vim keybindings,
not a Neovim process. Your Lua config and plugins are not loaded.
Preview images are disabled to keep documents from making
background network requests.
