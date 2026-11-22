# Conversations, context notes and provider swap

A project can hold several conversations (Main plus any you add with "New conversation"). All of them share the project folder; the
bar above the chat switches between them. Each conversation remembers its own agent, model, effort and session.

Files (inside `<project>/.flowstate/`):

* `threads.json` (private): the conversations and which one is active.
* `history.jsonl` (Main) and `history-<id>.jsonl` (others) (private): the chat history, replayed when the project is opened.
* `context/<id>.md` and `context/PROJECT.md` (shareable): readable notes of each conversation (your prompts, the replies, files
  changed) and an overview of all conversations. They are rewritten after every finished turn.

Provider swap: a session id only works with the provider that created it. When you change the agent or model route of a conversation,
or open it where no session exists, the next prompt carries a short hand-off note telling the agent to read `context/<id>.md` and
`context/PROJECT.md` first, so any provider can continue the work. "Context notes" in the bar opens the notes.

Implementation: `src/main/svc/threads.js` (service), `src/main/history.js` (per-conversation files via `threadOf`),
`src/renderer/components/threads-bar.js`.
