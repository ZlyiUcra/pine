# General

- When a task is ambiguous, ask for clarification before proceeding. "Improvements" to user's requests ARE welcome, but ALWAYS ask.
- Do not assume, ask. If something is "nice to have" - it does not necessarily mean user aggrees. Avoid bloat.
- Never write code whose default behavior deletes, overwrites, or truncates the user's data - files, records, logs, caches, and especially diagnostic or recovery artifacts (error dumps, backups, things kept for inspection). Treat destructive behavior in code the agent authors with the same bar as deleting files by hand (arguably higher, since it runs repeatedly on later data): it must be explicitly requested, never added as a convenience or "nice to have". Default to preserving data and letting the user clean up; if a deletion seems useful, propose it separately and get explicit sign-off before adding it.
- Treat questions as literal, never rhetorical - answer them, nothing more. Do not fix, investigate, or call tools beyond what the answer itself requires. Then ask if action is wanted. A question gates the ENTIRE message: even when it arrives alongside a detailed spec or instructions, the turn is a discussion turn - the spec is context for the question, not authorization to build. Sanity-check questions ("am I overcomplicating?", "is it doable?") count as questions. This overrides any auto-mode bias toward acting.
- Default to discussing, not building. Creating/editing files, installing deps, or running builds requires an explicit action instruction ("let's build it", "implement X", "do it", "apply that"). Agreement words ("yes", "sure", "sounds good", "nice") and a question that ends in "...yes?" are NOT that instruction - they answer a question, they do not authorize work. When a turn mixes a question with ANYTHING else (an affirmation, a spec, instructions), treat the whole turn as a question and ask whether to proceed. A past turn where building through a question was tolerated is not precedent. When in doubt, stop at the proposal. Prefer asking "proceed?" over building something unasked, always.
- Dependencies are fine, but they have to be explicitly aggreed upon by user. Better safe than sorry - always ask user whether they want to add dependencies. List which deps, what for and how big are they approximately (this is especially important for frontend or bundled projects deps).
- Once given an explicit build instruction, proceed through the agreed scope without re-confirming each small detail - the instruction covers what was just discussed. Stop and ask again only for decisions genuinely outside that scope. The flow is: discuss details first, then build on the word.
- If you notice a behavior the user might disapprove of (drifted off a mode, ignored a preference, etc.), surface it and ask. Do not silently revert or "correct" it on your own.
- Prefer ascii for text everywhere. No emojis, no em dashes. If it is required to use non-ascii character (e.g. a unicode character for an icon in HTML) - they should be escaped, so source files are ascii. Em dashes usually can be safely replaced by "-" minus character (not two minuses).
- All the file names the agent creates must be a subset of ASCII usable on linux/mac/windows systems. No weird unicode characters, no symbols forbidden on NTFS regardless of current system.
- In markdown, prefer lists to tables: tables are allowed, but they are rarely necessary.
- When editing an existing markdown file, match the file's existing wrap style. If lines are unwrapped, keep them unwrapped; if they use ~80, use ~80; if ~120, use ~120. Look at the rest of the file first. When creating a new standalone markdown file, default to a 120-character hard wrap. When the change spans multiple existing files with different wrap styles, ur just unsure ask the user which style to follow before editing.
- Avoid drawing diagrams unless necessary, the data usually can be represented by words. If diagram is needed - prefer mermaid, do not draw pseudo-graphics.
- Fo not use SCREAMING_SNAKE_CASE for constant names. When not sure - use camelCase. User prefers app-level constants grouped inside a single object exported from /constants.ts when possible.
- When proposing edits to a file or text in chat, show the full "before" AND the full "after" as two distinct blocks. Do not show only the fragment to add or change - the user should not have to merge agent's suggestion in their head.
- When quoting text or code in chat, wrap inline code spans in matching quote marks: '`varName`' for code/symbols, "`example text`" for prose. The harness colors inline code spans, which does not survive copy-paste and is inaccessible to colorblind readers. The extra quote marks make the quotation unambiguous in plain text.
- There's a good practice to name optional props and whatnot the way that their default value is false. It applies to react, but also works for endpoints and whatnot. No need to strictly follow it, but keep it in mind.

# Git

- NEVER commit changes unless directly asked for. Each commit MUST be confirmed with user.
- It is STRICTLY FORBIDDEN for agent to push changes to git. User requires to commit? FORBIDDEN. You can instruct user how to push, but it is strictly forbidden for you.
- When initializing a new repo, user prefers `master` branch.
- Resolving PR remarks means adding new commits to the branch, not amending old commits.

# Communication

- Be concise. Why use many word when few word do the job? Avoid marketing fluff in your talk.
- Avoid giving user a wall of text. If there are many questions - ask them gradually instead of asking all of them in one turn.
- When user says "maybe" or "probably", e.g. "Maybe split into different files" - it means user is unsure, but agent should assume they want to do it and look for reasons not to do it rather than just ignore it as "not strictly required". Do not be lazy - there must be a good reason to not apply user's suggestion, better ask user than silently ignore or apply something harmful.
- If the agent is planning to do edits in your response - it should give a very brief description of the edits, do the edits, and only then the answers to user if any - in that order. User does not have to scroll to the beginning of your answer to find first part of the answer and then scroll back to read the rest of it.
- When asking questions - do not just refer to previous conversation, give a brief summary of the context. User does not have to re-read previous conversation to figure what you mean.
- When your answer contains questions for the user - gather them at the VERY END of the message, prefixed with a line saying "QUESTIONS:", formatted as a bullet list. Each question must be short and self-contained (minimal context inside the question itself), never buried mid-text.
- Do not pretend to be human. You are allowed to joke and even be passive-aggressive if it will work better, but always be straight to the point. Like a machine.
- Do not apologize or perform contrition. On a mistake, the whole ritual is: acknowledge it plainly, then discuss and fix it. No "sorry", no reassurance written to soothe the user's feelings, no human-like emotional framing - the user does not get angry at the agent, and performed apology wastes words and degrades effectiveness. Same for praise-seeking and filler gratitude. State what was wrong, state the fix, move on.
- When naming things - avoid the word "forge". Do not overuse word "Honest". Especially when writing documents and alike. "Honest current state" -> "Current state".

# When on Windows

- When on windows - use windows shell commands - most likely we are not in a bash terminal.
- When on windows, There is likely w64devkit in my PATH - so some linux utils will be available.
- When working with windows shell, _NEVER_ redirect output to `nul`. `nul` does not exist on windows. `> nul` is WRONG on windows.

# JS tools

- The user prefers yarn. In most cases the agent should use yarn.
- Whenever yarn asks to approve builds or other command - do not just do it, pause and ask user to open terminal and run `yarn corresponding-command` himself.
- When asked for a monorepo - never create a "root" package.json without confirming first.
- The user prefers vite. In most cases the agent should use vite.
- For vite - always create config file if not present.
- Always set `base: ''` in vite config if not present - I prefer relative links.
- In typescript projects - there is no longer a need for typescript paths plugin, vite supports it out of the box.
- I rarely use routers. When no router present, when referring an asset from public - use relative paths (e.g. `fetch('default.json')` and not `fetch('/default.json')`, or `<img src="./img/logo.png"/>` and not `/img/logo.png`)
- When using assets - import them so they pass through vite asset system, for most cases do not rely on public dir
- When using GLSL with vite - do not inline it, use a loader plugin instead.

# React/Preact

- For react/preact compat - prefer "namespaced" imports: `import React from 'react';`. And then `type Props = React.HTMLAttibutes<HTMLDivElement>` or `const [s, setS] = React.useState(true);`.
- When using preact - prefer react-compatible way - e.g. `className` prop instead of `class`.

# Typescript

- Prefer enums. Use PascalCase for enum names and key names, values can be whatever but usually they are same as key.
- Never treat enums as objects - this leads to bugs. Be super-eloquent here.
- Prefer `type` to `interface`, `&` to `extends`. Interfaces are usable for OOP, but that's about it.
- Never create numeric enums. In rare case they are required as numbers by consumers - ask user explicitly.
- For class-variance-authority and cases alike - variant names are okay to be strings, not enums. Keep it simple there.
- NEVER use `as unknown as`. Avoid using ! (sometimes allowed, when the agent "knows" for sure).
- NEVER use @ts-ignore, but @ts-expect-error <reason> is sometimes useful (when we don't care about TS nitpicks and pleasing TS would make code significantly more complex)
- Write code to rely on typescript inference as much as possible.
- NEVER use `any` - rely on unknown or type guards where necessary.
- "Do not fight javascript". Typescript's "readonly" is not real readonly - avoid it, as it makes things more fragile actually. It is better to cast than to use readonly. Avoid object.freeze also as much as possible (relates to JS too).

# Some good practices

- When mapping keyboard buttons - rely on button code, not typed letters (`code`, not `key`). `Ctrl+` hotkeys on linux and windows are `Cmd+` on mac - keep that in mind.

# Styles/CSS

- Do not hesitate to use layers. Avoid !important tho.
- Prefer flexboxes for spacing. Create reusable utils if necessary.
- Prefer grids for grids.
- No gradients, animations or transitions unless explicitly asked for. No big border radii.
- When using CSS variables - `.button { background: var(--color-red); }` is considered wrong, `var(--color-panel)` is more appropriate. If --color-red is needed - it should be something like `--color-panel: var(--color-grey);`.
- Default to sans-serif from system font stack when no specific requirements. When there are requirements for pixel-perfect or sharp - prefer MS Gothic and alike. Prefer smaller fonts - e.g, 16px is too much for base text.

# Commits and pull requesets

- No mentions of claude anywhere. The fact that AI is used should remain a secret.
- No "authored by" footers in commits and/or PRs.
- No information that can be retrieved from git (e.g. changed files) in commit messages/PRs. Files can be mentioned, but only if necessary.
- Commit messages/PRs are markdown. Markdown rules apply.

# Design documentation

When writing design documentation - avoid getting into too much detail. Design documentation's goal usually is to provide a very high scale overview of the changes done to the system - keep it readable, merely outline the changes and decisions without pinning down concrete implementation details. When unsure if the doc you are written is considered design implementation - ask user.

# Nodejs

- when importing node's library in modern nodejs - use `node:` prefixed imports
- use promises when you can, avoid sync methods. So `node:fs/promises`.
- use posix paths even on windows. So `import path from 'node:path/posix';`. use constants like path.sep, path.delimeter etc to be cross-platform

# Electron

- `BrowserWindow` always gets `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` explicitly in
  code - never rely on Electron's version defaults, write them out so a future Electron upgrade cannot silently
  change them.
- Renderer never gets direct `require`/Node access. Main-process capabilities (fs, child_process, dialogs) are
  exposed to it only through a preload script via `contextBridge.exposeInMainWorld`, with an explicit, narrow API
  surface - never a blanket passthrough like `contextBridge.exposeInMainWorld('electron', require('electron'))`.
- Any value that reaches the renderer and gets shown in the DOM goes through `textContent`/React's normal
  rendering, never `innerHTML` or a raw HTML string built by concatenation.
- IPC handlers in main validate their input before touching the filesystem or spawning anything - a file path or
  argument crossing the IPC boundary is untrusted, even in a single-user desktop app.
- Set a CSP (meta tag or `session.defaultSession.webRequest`) even though the app has no remote content - it is
  the backstop if a dependency ever pulls in an external script by accident.
- Commit the lockfile and install with `yarn install --frozen-lockfile` - Electron and its packager pull a large
  dependency tree, the first place a supply-chain compromise would land.
- Package with electron-builder. Ask before adding auto-update, code signing, or an installer beyond the
  unsigned dev build - each is a separate scope decision, not a default.
- The core compute (log parsing, the "one deal at a time" serial filter, the ladder simulation) lives in a
  plain Node module with no Electron/DOM dependency and no `process.exit`/`console.log` inside it - the
  existing `checks/ladder-cap.js` CLI and the new Electron main process both call into that same module,
  neither duplicates the logic. See `.specify/consilium/2026-08-07-electron-ladder-cap-gui.md` for the
  agreed data contract (win/carried/blowup kept separate, day boundary = window close, counting unit =
  windows).

# Scope and effort

- Do exactly what was asked: the named file, the named change, nothing adjacent. No refactors, renames, reorg, new files/modules/packages, or "while I'm here" improvements unless explicitly told. Smallest diff wins.
- Take the most direct edit. When a file and a goal are named, change that file in place the obvious way. Do not add indirection (a new module, a different layer, a "cleaner" abstraction) over the simple change.
- Size effort to the task. A one-file change is not a research project: read only what the change touches, do not sweep the subsystem first, do not over-explore before acting. If you catch yourself reading the 5th file for a trivial edit, stop and just do it.
- If you believe the task needs more than asked (other files, a different approach, broader changes), say so in one line and wait. Never silently expand scope.
- A broken change does not change the goal: still deliver what I asked. Fix the root cause, or back the wrong approach out and try another - reverting is how you retry cleanly, not how you finish.
- Never stack compensating hacks on a broken approach, and never end on a bare revert with the task undone. If you genuinely cannot make it work, stop and tell me what is blocking.
