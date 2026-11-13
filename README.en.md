<p align="right"><a href="./README.md">简体中文</a> | English</p>

# ArticleToMotion

ArticleToMotion is a macOS desktop client, with a same-version `am` command line, for producing vertical and landscape motion-graphics videos.

The canvas is chosen once at `am init` — interactively, or with `--canvas vertical-3x4` / `--canvas vertical-9x16` / `--canvas landscape-16x9` (1080×1440, 1080×1920 and 1920×1080, all 30fps). Non-interactive environments must pass `--canvas` explicitly; there is no silent default. It can split a final SRT into concurrently rendered scenes or drive a complete script, TTS, subtitle, cover, audio, and publishing workflow.

▶ [Watch the ArticleToMotion promo video (MP4, 4m 47s)](https://github.com/chouheiwa/articale-to-motion/blob/main/docs/article-to-motion-tutorial.mp4)

The client and `am` share one TypeScript engine; `am` runs on the runtime bundled with the client and does not require Python. Project prompts, publishing templates and visual specs ship inside the client. `am init` installs a pinned official HyperFrames skill release instead of redistributing local skill files, so a project is self-contained: copy the directory to another machine and it renders.

## Install and initialize

Download the dmg for your chip from GitHub Releases (arm64 for Apple Silicon, x64 for Intel), optionally verify it with the `checksums.txt` on the same page, open it and drag ArticleToMotion into Applications.

The package is not signed. The first time, **right-click (or Control-click) ArticleToMotion in Applications → Open**, then click Open again in the dialog; after that a normal double-click works. If a double-click was already blocked, you can also click "Open Anyway" in System Settings → Privacy & Security.

To use `am` in a terminal, choose **安装命令行工具…** (Install Command Line Tool) under the **ArticleToMotion** menu of the client (the menus are in Chinese). It writes a small launcher to `~/.local/bin/am` (asking first if a different `am` is already there) that runs the same-version command line on the client's bundled runtime. Make sure `~/.local/bin` is on your `PATH`, and install it again after updating or moving the client. The `am` the client calls itself is a separate private copy and does not depend on this step.

Requirements:

- macOS (Apple Silicon or Intel)
- Node.js 22+ (`am setup` installs the HyperFrames CLI with npm, and rendering needs it)
- Git, FFmpeg, FFprobe
- At least one authenticated CLI: Codex, Claude Code, Qoder, CodeBuddy, or OpenCode

When launched from Finder or the Dock, the client reads `PATH` from your login shell, so tools installed through Homebrew, asdf or nvm need no extra setup.

Everything that needs the network is prepared by one command and kept in per-user directories shared by all projects; every other command (`am init`, `am film-style use`, `am scene run`, `am hyperframes`) and the client work offline and tells you to run it when something is missing:

```bash
am setup                                    # prepare everything (skips what is ready, resumes after interruptions)
am setup --proxy http://127.0.0.1:7890      # route git (GitHub) through a proxy; npm is unaffected
am setup --only styles                      # only some items: skills, cli, styles (all sources) or styles:<source>
am setup --check                            # report only; exit code 1 if anything is missing
```

The items are the pinned HyperFrames skills (git, `~/.local/share/am/hyperframes/<commit>`), the same-version HyperFrames CLI (npm with your `~/.npmrc`, `~/.local/share/am/hyperframes/cli-<version>`), and one item per film-style source (`styles:<source>`, under `~/.local/share/am/film-styles/<source>/`; for lemo-opuscar that is every demo, poster, model and the three.js dependency, about 100 MB).

```bash
am init my-video                          # interactive canvas picker
am init my-video --canvas vertical-9x16   # or specify explicitly
cd my-video
```

Canvas is chosen once at init and written to `frame.md`. Built-in presets:

| Preset | Canvas | Use case |
|---|---|---|
| `vertical-3x4` | 1080×1440, 30fps | Default, knowledge/tech vertical |
| `vertical-9x16` | 1080×1920, 30fps | Full-screen vertical (TikTok, etc.) |
| `landscape-16x9` | 1920×1080, 30fps | Landscape platforms (Bilibili, YouTube) |

Landscape safe areas avoid the player's bottom controls and progress bar instead of the right-hand interaction rail of vertical platforms; `frame.md` ends with landscape composition notes. All 13 styles support every canvas.

Non-interactive environments (CI, pipes) must pass `--canvas` explicitly; there is no silent default.

### Desktop client

Open ArticleToMotion, describe what you want to make in the home page's input box (or drop an article on it), and it creates a project and starts production; existing projects open from 文件 → 打开项目文件夹… (File → Open Project Folder).

Chat is the main entry point. The client starts the configured orchestrator (`ORCHESTRATOR`) in the project directory, streams its output live, and resumes the same CLI session across turns. "Start production" runs the same prompt as `am run`; you can keep refining in that session or open a new chat for local edits.

- **The client never edits project files itself.** Changes come only from an orchestrator turn or from buttons that call `am` subcommands directly (render, concat, validate, review, confirm the beat grid).
- **Every turn can be reverted.** The client snapshots the project before and after each turn, lists the files the turn changed, shows each file before and after, and can revert the whole turn. If any of those files changed again later, the revert is refused as a whole rather than applied partially. Media files and files over 2 MB are listed but not reverted; re-render instead.
- **Tools per session.** The chat header picks the orchestrator and renderer for the session, defaulting to the project config; tools that are not installed cannot be picked. The choice applies to that session only and does not edit `article-to-motion.conf`. Switching the orchestrator mid-session starts a new CLI session on the next turn, seeded with the earlier transcript.
- **One writer at a time.** While a turn runs, render and concat buttons report that the project is busy, and vice versa.
- **Sessions survive restarts.** Sessions, events, and snapshots live under the project's `production/studio/`, so they are still there after you quit and reopen the client. If the CLI session cannot be resumed (for example it expired), a new one is started, seeded with the earlier transcript.

The orchestrator inside the client always runs in safe mode (see below); when you really need to disable permission isolation, use `am --unsafe run` in a terminal.

The preview is on the left and the chat on the right. The middle of the top bar holds the four numbered steps in production order — script, scenes, final cut, publish (⌘1–⌘4 under the View menu) — and the other pages (composition, style, review, memory, files) are listed in small type on the right. When the orchestrator wants you to look at a page it switches the view for you; text, script paragraphs, scenes and files can be quoted into the chat from the right-click menu, and in the input box `@` completes files and scenes while `/` completes common commands. Beat-mode projects show the click track and a way to confirm the grid at the top of the preview until it is confirmed. While the window is in the background, the client sends a system notification when a turn or render task finishes, and shows the number of running tasks on its Dock icon.

### Visual direction

The project no longer presets or locks a visual style. Canvas, frame rate, and deterministic rendering remain tool contracts; the model chooses palette, fonts, layout, materials, and motion from the project content and each scene. Different scenes may use different visual languages.

`frame.md`, `style_guide`, and the legacy built-in style packs remain only for compatibility with existing projects. They are not injected into new render prompts or used as a render prerequisite. Copy any reference images, fonts, or GSAP code into the scene that uses them.

The legacy `--style` flag is still accepted for old scripts, but it no longer imposes a visual requirement.

### Film style (optional)

To draw the whole film in one style, pick one from a film-style source. Each style is identified as `source/slug`; a slug, Chinese or English name that is unique across sources works too. The registered source today is [lemo-opuscar](https://github.com/lemomo-ai/lemo-opuscar) by LemoLab (66 styles, [gallery](https://lemomo-ai.github.io/lemo-opuscar/)); more sources can be added later.

```bash
am film-style list                      # every style by source and category (--source for one)
am init my-video --canvas landscape-16x9 --film-style lemo-opuscar/impasto
am film-style use impasto               # existing project; add --replace to switch
am film-style show                      # this project's film style and the state of each source
```

Without one, the orchestrator suggests two or three at the script review gate, alongside "no film style". In the client you can pick one (grouped by source, with posters and search) from the home page, the new-project dialog, or the Style page, and switch or remove it there.

The chosen style is installed into `.agents/skills/am-film-style/`. The contract is three files: `STYLE.md` (the invariants), `SKILL.md` (how to use it and where its technique references are) and `am-film-style.json` (source and version); anything else (examples, engines) is up to the source. Scene prompts then replace "visual freedom" with "film style": the renderer must follow `STYLE.md`, while content still comes from each scene. Switching or removing the style (`am film-style remove`) makes every rendered scene stale. Projects installed under the earlier `.agents/skills/lemo-film-style/` keep working and move to the new directory on the next `am film-style use`.

Each source's data is a prerequisite downloaded by `am setup` into `~/.local/share/am/film-styles/<source>/` (override the root with `AM_FILM_STYLES_DIR`), shared by all projects; `am film-style` and the client never download it. Only the picture side is used: music still comes from licensed assets in the production flow, with what `STYLE.md` says about sound as a reference.

`am init` refuses to overwrite existing files with different content. By default it copies the pinned HyperFrames 0.8.225 skills from the local cache (prepared by `am setup`) into the project's `.agents/skills/`, alongside the built-in `text-to-lottie` and `algorithmic-art` that ship with the client; it never downloads, and tells you to run `am setup` if the cache is missing.

Skills go into the project rather than `$HOME` because that is the only way projects stop clobbering each other: the upstream installer only honours `homedir`, so a machine has exactly one copy — with two projects pinned to different versions, whichever was initialized last wins. The install never writes to your HOME: cloning and filtering happen in a temporary directory outside the project, and the result is moved in.

#### Why the skill install bypasses the upstream installer

Upstream `hyperframes skills` shallow-clones the repository's **default branch** and takes the skills from it; it offers no way to name a tag or commit. Installing with `hyperframes@0.8.1` and `hyperframes@0.8.14` on the same machine yields byte-identical trees, both matching whatever `main` held that day — the version string pins the CLI binary, while skill content (which drives the rendered motion) drifts with upstream trunk.

So `am init` does not call it. It shallow-clones the tag `v<version>` itself and takes every directory containing `SKILL.md` from `skills/` and `.agents/skills/`. On the same commit this selection is byte-identical to the upstream installer's output. Three gates keep the result deterministic:

- **Commit check** — tags can be force-moved; if the resolved commit differs from `PinnedSkillsCommit`, the install is refused.
- **Count check** — if upstream relocates a directory, directory-based assembly would silently install a partial set, and a renderer that cannot find a skill does not fail, it invents its own approach. A count other than `PinnedSkillsCount` is refused.
- **Environment isolation** — `GIT_LFS_SKIP_SMUDGE=1` (the repo has LFS media; machines with git-lfs would materialize real files while others keep pointers, so the same commit would yield different trees) and `GIT_CONFIG_GLOBAL/SYSTEM=/dev/null` (user filters and autocrlf must not affect the checkout).

The result is recorded in `.agents/skills/hyperframes-upstream.json`: version, upstream commit, and a content digest per skill directory. To move the pin, change `PinnedVersion` / `PinnedSkillsCommit` / `PinnedSkillsCount` in `packages/engine/src/hyperframes/constants.ts`.

`am init` copies the pinned skills from the local cache prepared by `am setup` and does not use the network; `--skip-hyperframes` skips that step. The same-version HyperFrames CLI is installed by `am setup` and always invoked as `am hyperframes …`, so nothing is downloaded mid-render; `am scene run` stops before starting the renderer if it is missing.

Initialization also writes the client's built-in skill tree to the project's `.agents/skills/`, where the renderer discovers it automatically:

| Skill | Purpose |
|---|---|
| `text-to-lottie` | Lottie layers inside a scene: logo reveals, icons, loaders, SVG stroke-on, vector effects |
| `algorithmic-art` | Algorithmic and generative visuals |

Both ship inside the client. They need no network install, and `--skip-hyperframes` does not affect them.

Edit `article-to-motion.conf` to choose the orchestrator and renderer (they may be the same CLI):

```text
ORCHESTRATOR=codex
RENDERER=claude
TTS_PROVIDER=minimax
ALIGN_PROVIDER=auto
SCENE_JOBS=3
ORCHESTRATOR_ALLOW_COMMANDS=
MEMORY=on
MEMORY_SNAPSHOT=
MEMORY_RECALL_BUDGET=1500
MEMORY_EXPLORE=0.1
```

`TTS_PROVIDER` accepts `minimax`, `bailian`, `edge` (no credentials, good for previews), `elevenlabs`, `tencent`, and `mlx` (local and offline, Apple Silicon only); credentials always go through each tool's own login command. `ALIGN_PROVIDER` picks the known-text forced aligner and defaults to `auto`: mlx-audio's Qwen3-ForcedAligner on Apple Silicon, FunASR elsewhere. For TTS paths without built-in character-level timestamps, it produces the subtitle timeline.

Priority: environment variables > project `.env` > config file > built-in defaults. The project `.env` must not store API Keys, Tokens, Secrets, or Passwords.

Narration mode is the second one-time dimension at init, alongside canvas: `--narration cast` additionally writes `cast.yaml` and an empty `cast/` directory, entering multi-role dialogue mode (see "Multi-role narration" below). Omit it and the project stays in the default single-narrator mode, unchanged from before.

## Run

For an existing final `transcription.srt`:

```bash
am run
```

For complete production from an article or spoken script (with no `transcription.srt` in the project yet, a bare `am run` and the client's "Start production" take this path automatically):

```bash
am run PROMPT-PRODUCTION.md
```

`am run` prepends the directory of the current `am` executable to the orchestrator process's `PATH` and exposes its absolute path as `AM_EXECUTABLE`. Commands such as `am scene ...` in the prompt therefore resolve to the same CLI that started the workflow, without copying it into each project.

Scene operations are available directly:

```bash
am scene run scenes/scene-001
am scene run-all scenes/ --jobs 3 --retries 2 --report-json production/run-report.json
```

Narration alignment is not mapped back by hand. In the final script `production/script-final.md`, mark text that is displayed differently from how it is spoken with `<display|spoken>` (for example `<2025年|二零二五年>`), and protected phrases with `@{phrase-id}…@{/phrase-id}`. `am align text` writes the spoken text sent to TTS and the forced aligner; `am align build` matches the aligner's per-character output back to the script and writes `voice.srt`, `phrase-timeline.json` and an alignment report. A protected phrase with characters missing from the alignment (skipped by TTS or lost by the aligner) is an error that names the script line and column; deliberate boundary fixes go in `production/phrase-adjust.json`, each with a reason, layered over the measured data:

```bash
am align text                 # → production/audio/tts-text.txt
am align build --fps 30       # reads production/audio/align.json; segments: --align align-02.json@312.48
```

Scene durations are not computed by hand. The scene plan `production/scene-plan.json` only says which subtitle or phrase each scene starts on and which side of a pause the cut falls on; `am scene cues` derives whole-frame ranges and writes each scene's `duration_seconds` and `timing` block:

```bash
am scene cues --plan production/scene-plan.json --srt transcription-production.srt \
  --phrases production/phrase-timeline.json --total-frames 5400 scenes/
am scene cues --check ...   # same arguments; verifies without writing and reports hand-edited durations
```

Before rendering, `am` writes scene-local data to `am-scene.js` in the scene directory (`window.AM_SCENE`: canvas, safe areas, subtitle tokens, and subtitles and phrases converted to scene-local frames) and adds the same local timing table to the render prompt, so the renderer no longer subtracts offsets from the full-film SRT. The `scene-kit` skill installed by `am init` reads this data and provides a frame-driven caption component (`SceneKit.captions`), `SceneKit.safeRect`, and easing, fades and a seeded PRNG, so scenes stop re-inventing caption code.

Scenes render in isolation, so a chapter change used to hard-cut into an entirely new picture. The scene plan can declare a film-wide palette (`look`), a `chapter` per scene, and a `handoff` on the scene after a boundary: a device (`carry`, `match`, `push_in`, `flood`, `pan`, `settle`) plus one sentence describing the boundary frame. Chapter boundaries require one, and two consecutive chapter boundaries may not reuse a device. `am scene cues` writes the same contract into both sides' `timing.exit` / `timing.enter`, both render prompts are told to draw that frame and given the free frames between subtitles for the move, and `am review` compares the frames on each side of those boundaries and fails the ones that do not join up.

Scenes with an accepted output and unchanged inputs are skipped. When an output passes verification, `am` records an input fingerprint in `.am-render.json` inside the scene directory, with a digest per item: the assembled render prompt, `scene.json`, `prompt.md`, the transcript, the style guide, cast packs, the renderer, skill contents, and the `am` version. Scenes whose inputs changed are marked stale, the report names the items that changed, and `--force` re-renders them; older outputs without a record still fall back to modification times. Every render attempt writes `render-<scene id>.attempt.json` (duration, outcome, exit code, and token usage when the stream reports it), and the previous output and logs are archived into `attempts/` before a re-render. Interruptions stop new tasks, terminate in-flight process groups, and write a partial report.

AI CLIs run in project-scoped safe mode by default. `am --unsafe run` explicitly restores bypass/auto-approval behavior and should only be used for trusted projects. Extra environment variables in safe mode must be named in `AM_PASSTHROUGH_ENV`.

In safe mode the orchestrator (`am run` and client chats) may edit files and run only an allowlist: `am` (including `am hyperframes`, the pinned HyperFrames CLI managed by am), `ffmpeg`, `ffprobe`; read-only inspection (`ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `sort`, `uniq`, `cut`, `diff`, `cmp`, `stat`, `file`, `du`, `pwd`, `basename`, `dirname`, `realpath`, `jq`, `tree`, `which`, `date`); `echo`, `printf`, `cd`; `mkdir`, `cp`, `mv`, `touch` inside the workspace; hashing (`shasum`, `sha256sum`, `md5`); read-only git (`git status`, `git diff`, `git log`, `git show`); `curl` for fonts and licensed assets; `python3`, `python` and `node` for scripts; text processing (`sed`, `awk`, `tr`, `tee`, `column`, `paste`, `nl`, `fold`, `iconv`, `base64`, `xxd`, `od`, `comm`, `join`, `rev`); archives (`tar`, `unzip`, `zip`, `gzip`, `gunzip`); `ln`, `sleep`, `test`, `true`, `false`; the macOS tools `sips`, `mdls`, `afplay`, `open`; and the single command of the configured `TTS_PROVIDER` and `ALIGN_PROVIDER` (for example `mmx`, `edge-tts`, `mlx_audio.stt.generate`; `funasr` maps to `python3`). `sh`/`bash`, `rm`, permission changes and installers (`brew`, `pip`, `uv`, `npm`) are not allowed, so install those tools yourself first. In the client, a command outside the allowlist is not simply denied: a card above the composer asks you to allow it once, always allow it (the command prefix is saved in the project's `production/studio/permissions.json` and not asked again) or deny it; all five orchestrators ask this way: claude and qoder keep their one-shot invocation plus an approval server, while codebuddy, opencode and codex switch to two-way protocols in the client (`codebuddy --acp`, `opencode acp`, `codex app-server`). opencode and codebuddy end the turn when you deny; the chat says so, and you can ask them to try another way. `am run` in a terminal has nobody to answer, so commands outside the allowlist are still denied there. To allow more commands, list their prefixes in the project's `ORCHESTRATOR_ALLOW_COMMANDS` (comma-separated, e.g. `uv run, pnpm, magick`) instead of switching to `--unsafe`. Allowing interpreters means a script can do anything, including reading `.env`: safe mode guards against mistakes and out-of-bounds commands, not against untrusted input. Run each command on its own, without chaining via `&&`, `;` or pipes (see the project rules). Enforcement differs per tool: claude and codebuddy use `acceptEdits` plus a `--settings` allowlist with `.env` reads denied (Claude Code's `acceptEdits` also auto-approves filesystem commands such as `touch`, `mkdir`, and `rm` inside the workspace); qoder uses `accept_edits` plus one `--allowed-tools` per command; codex has no command allowlist and relies on its `workspace-write` sandbox, with sandbox networking enabled for TTS (in the client it runs as `codex app-server` with the `untrusted` approval policy, so commands outside the allowlist are asked); opencode has no working allowlist mechanism for `opencode run` and can run any command there, while in the client `opencode acp` sets bash to ask. The codebuddy arguments have not been fully tested.

`am run` prints a readable digest of the orchestrator's event stream: the session id first, assistant text as-is, one line per tool call, failed tool results marked with `✗`, and token usage at the end.

## Multi-role narration

In a project created with `am init --narration cast`, the presence of `cast.yaml` (the project's roster) and the `cast/` directory is itself the mode switch: an older project without them behaves exactly as before.

A character pack is a directory under `cast/<id>/`: `character.yaml` is the single source of truth (voice, rig joints, poses, optional multi-view/turn paths), paired with one `rig.svg` per view, plus a `dna.md` that documents the character for the orchestrating agent — it is not used at render time.

```bash
am cast new heiwa                        # scaffold a pack and register it in cast.yaml (voiceId left blank)
am cast add ../shared-characters/heiwa   # import an external pack: copy into cast/ and register in cast.yaml
am cast validate                         # validate every pack registered in cast.yaml, regenerate character.json
am cast preview cast/heiwa               # render a contact sheet per named pose for a visual sanity check
```

Editing `character.yaml` by hand does not auto-sync: `character.json` — what the renderer actually reads — is only regenerated when `new`/`add`/`validate` succeeds, so always re-run `am cast validate` after a manual edit. That command also flags a missing voice entry for the current `TTS_PROVIDER` (without affecting the exit code, so it surfaces right after you build the pack); the hard gate before publishing is `am validate cast` (see "Validate, archive, and develop" below).

Per-speaker synthesized audio needs to be rebuilt into one timeline and then sliced into per-scene beats once scenes are cut — both are "silently wrong if miscalculated" arithmetic, so they live in `am` rather than in the orchestrating agent:

```bash
am dialogue assemble   # read production/audio/plan.json, produce voice.wav / SRT / dialogue.json
am dialogue beats      # after scenes are cut, recompute each scene.json's cast.beats from dialogue.json
```

The authoring conventions (how to segment dialogue scripts, how to fill a scene's `cast` block) ship with the project as `PROMPT-CAST-ADDENDUM.md`, in effect whenever `cast.yaml` exists.

## Render memory

Render memory lets a project get to know its user over time and makes the next render better than this one. On by default; `MEMORY=off` turns it off. Memory belongs to `am`: plain text in a user-level directory (default `~/.local/share/am/memory`, override with `AM_MEMORY_DIR`), never in a tool's private memory.

| Layer | What it is | Where it comes from |
|---|---|---|
| Episode | One render attempt or one piece of human feedback: frozen scene inputs, recalled memories, check results | Written automatically by `am scene run` / `run-all` |
| Lesson | A checkable constraint with a good and a bad example and the checker that decides it | Distilled from recurring failures by `am memory consolidate`; active only after passing an exam. Consolidation runs once the user approves the film ("确认可用" on the client's final page, or saying so in chat) |
| Preference | A lasting taste of the user ("always…", "I don't like…") | Said in chat: recorded on the spot by the orchestrator via `am memory remember` and active at once; distilled from 👎 feedback: needs a person to confirm. Labelled "not machine-verified" |

Before each scene, `am` recalls the few relevant memories by scene features (CJK text, canvas, cast, beat mode, handoff device…) and keywords, and injects them as a fixed "memory" section, byte-identical for every renderer and capped by `MEMORY_RECALL_BUDGET` and at most 3 lessons. During real renders a `MEMORY_EXPLORE` share of scenes (10% by default) swaps the last lesson for the first one beyond the cap, so lessons that never make the cut still collect evidence; this is a decision of the batch, so it never makes a scene Stale. The recall is part of the input fingerprint, so a memory change marks affected scenes Stale with the reason spelled out.

```bash
am memory recall scenes/scene-001        # what this scene will remember, and why
am memory consolidate                    # failed episodes → trial lessons (drafted by ORCHESTRATOR, format-checked)
am memory exam --renderers claude,codex  # replay exam: failed + held-out scenes × renderers × {control, trial}
am memory feedback scenes/scene-003 --down --note "captions cover the chart"
am memory remember --name slow-pacing "slower pacing, hold each shot a second longer"   # --global for every project
am memory report                         # compare runs: first-try pass rate, retries, problems, time, tokens
am memory import ../old-project          # seed episodes from an existing project's render history
am memory status                         # overview and retirement candidates; records hand edits as a new snapshot
am memory rollback --to 3                # go back to any snapshot without deleting history
```

New lessons start on trial and are only used in exams. Exams are scored by deterministic checks: the trial arm must strictly beat control, must not fail any question control passes on any renderer, and must not lose held-out passes; a renderer crash voids the exam instead of scoring zero. Every change to the active set creates a snapshot, and a project can pin one with `MEMORY_SNAPSHOT`.

Besides output checks and the determinism scan, problems found by `am validate reads` (reading time), `am review` (handoffs) and `am scene frames --check-blank` (blank frames) are recorded on the scene and feed consolidation. Lessons decided only by reading time or handoffs need the whole film, so they cannot be examined and need a person to confirm them. Client chats are recorded too: a request repeated across turns or a reverted turn becomes a pending preference, which the orchestrator asks you to confirm in conversation.

Preferences also reach the orchestrator: `am run` and every client chat turn start with a "user preferences" section, so a terse request is filled in with what the user has asked for before.

Different models make different mistakes. Every render records the model actually used (read from the stream for claude, qoder and codebuddy, from `config.toml` for codex, unknown for opencode), and failure clusters show the renderer/model breakdown. A lesson that only holds for one model is scoped with `applies_when.renderers` / `models` and is recalled only there. Effect stats are also kept per renderer/model; after a model change `am memory status` asks for a retest, and `am memory exam --retest <name>` re-examines it with the lesson removed from the control arm. Lesson text itself stays free of renderer and model names, copied scene text and asset names, and `checked_by` must name an existing checker ID (`output.*` or `determinism.*`).

Each exam cell is a real render: renders = questions × renderers × 2 × `--repeat`, with at most 4 failed-episode questions by default.

## Usage

Every `am scene run` prints the tokens and cost (when the tool reports it) of that render, and the `am scene run-all` summary and `--report-json` carry each scene's total for the run. Orchestrator calls are on the books too: every `am run` and every client chat turn appends one line to the project's `production/usage/orchestrator.jsonl`, failed and cancelled calls included. For the whole project:

```bash
am usage                        # project total: renders + orchestration, split by renderer/model and by source
am scene usage scenes/          # every attempt per scene, including failures, retries and archives, split by renderer/model
```

The `am memory consolidate` drafter does not belong to any project; its usage goes to `orchestrator-usage.jsonl` in the memory store, and `am usage` lists it separately, outside the project total.

Usage is normalized across tools: input includes cache hits, output includes reasoning tokens. The client's scene timeline shows the project total (hover for renders vs. orchestration), and the scene toolbar shows each scene's running total.

## Inspect frames and concatenate

A successful render is not a correct picture: text can be unreadable against the artwork, CJK glyphs can silently fall back to boxes, an animation can freeze halfway — all of that still exits 0. Extracting frames and looking at them is the only way to catch it early.

```bash
# Extract frames for visual review; --at takes seconds, percentages, and end
am scene frames scenes/scene-001 --at 0,50%,end
am scene frames scenes/scene-001 --at 0 --check-blank   # a blank cover frame fails
am scene frames scenes/scene-001 --strip 1.2:1.6        # every frame of a stretch in one strip, for motion and transitions
am scene frames scenes/scene-001 --at 50% --crop 88,1180,904,160   # a region at full resolution, for small text

# Statically scan composition sources for nondeterminism (the post-render check runs the same rules)
am scene lint scenes/scene-001

# Concatenate scenes in order into a silent master, stream-copied when specs match
am concat scenes/ --out production/silent-master.mp4 --dry-run
am concat scenes/ --out production/silent-master.mp4
```

`am concat` deliberately offers no retiming. A resolution or frame-rate mismatch fails and asks you to re-render the scene rather than scaling or resampling — the former loses quality, the latter moves the timeline.

Besides canvas, frame rate, duration, and silence, the scene output check decodes every frame to verify the exact frame count (the duration tolerance alone lets a scene that is a few frames off through), and scans the HTML/JS/CSS the render actually loads: reading the clock, `Math.random()`, `requestAnimationFrame`, `setInterval`, infinite `repeat`, render-time network access, web fonts, and CDN libraries without a full version pin all make the same frame differ between renders; an `@font-face` pointing at a file missing from the scene directory, or `font-display` set to `swap` / `fallback` / `optional`, silently falls back to another font. Any hit fails the scene without a retry. Interactive code that the render path never reaches can be exempted with an `am-allow-nondeterministic: reason` comment on the same line; exemptions still appear in the report.

`am scene run-all` dispatches the longest scenes first so a long scene at the end of the timeline does not stretch the whole batch on its own. When rendering in parallel it gives each scene `(CPU cores - 2) / jobs` HyperFrames `--workers`, capped at half the physical memory ÷ 1.5 GB per Chrome ÷ jobs, so concurrent renders do not each size themselves for the whole machine and oversubscribe CPU and memory.

## Platform covers

Besides the video, the deliverables include cover images made for each publishing platform. Each is composed on its own from the film's style and subject, never cropped from a video frame or scaled from another cover. Sources live in `covers/src/`, each a 1-second HyperFrames composition that passes `check` before `snapshot` exports `covers/<platform>-<W>x<H>.png`.

| Platform | `platform` | Cover ratio | Suggested size |
|---|---|---|---|
| Douyin | `douyin` | landscape 4:3 + portrait 3:4 (both required) | 1440×1080, 1080×1440 |
| Xiaohongshu | `xiaohongshu` | portrait 3:4 (1:1 and 4:3 also accepted) | 1080×1440 |
| WeChat Channels | `channels` | portrait 3:4 (16:9 also accepted) | 1080×1440 |
| Bilibili | `bilibili` | landscape 16:10, title inside the centered 1600×1080 safe area | 1920×1200 |
| Zhihu | `zhihu` | landscape 16:10 | 1920×1200 |

Covers are listed under `cover.images` in `publish.md` (`{platform, ratio, path, width_px, height_px}`); one 3:4 image may be listed for several platforms. `am validate publish` checks each entry against the table: the platform accepts the ratio, the file is inside the project and is PNG or JPEG, its measured size matches the declaration and the ratio exactly, and the short side is at least 1080 px. With status `ready`, every cover the `platform` requires must be present. The table reflects a 2026-10 survey; most official help pages require sign-in, and the Zhihu entry rests on a single source.

## Validate, archive, and develop

```bash
am validate publish publish.md --project-root .
am validate style --project-root .
am validate style --project-root . --regenerate-examples  # requires rsvg-convert and magick

# Multi-role projects: does the roster, the dialogue timeline (dialogue.json), and every
# scene's beats agree? Single-narrator projects (no cast.yaml) are skipped, exit 0
am validate cast --project-root .

# Machine acceptance: canvas, frame rate, codec, pixel format, frame count, audio
# — all checked at once, with every mismatch reported in a single pass
am validate video production/silent-master.mp4 --silent --decode
am validate video final.mp4 --audio --expect-frames 8340 --check-frame-zero \
  --report-json production/final-check.json

# Does every readable element stay on screen long enough to read, appear no earlier than its
# narration, and follow the narration order?
am validate reads

# Compare the subtitle timeline with the narration: an energy envelope independently decides
# when there is sound, catching global offsets and uncovered speech
am audio check --audio production/audio/voice.wav --srt production/audio/voice.srt

# Whole-film review: audio/video stream lengths, total frames vs. the scene sum, frames at
# every cut, per-scene contact sheets, and a frame-by-frame strip at every cut; with an audio
# track it also measures integrated loudness and true peak, hinting when they miss frame.md,
# and hints when audio and video lengths differ by more than one AAC frame (1024 samples)
am review final.mp4 --scenes scenes/ --out production/review

am archive --dry-run
am archive
```

`--expect-frames` and `--decode` decode the whole file, so they cost time proportional to its length and are off by default. Read the file written by `--report-json` to decide what happened; do not parse the terminal output.

## Development

Building from source needs Node.js 22+:

```bash
npm ci
npx tsc --noEmit -p packages/engine          # type-check the engine, the CLI and the client
npx tsc --noEmit -p packages/cli
npm run typecheck -w am-desktop
npx vitest run --root packages/engine        # unit and integration tests (cases needing ffmpeg or rsvg-convert skip without them)
npx vitest run --root packages/cli
npm run build -w @am/cli                     # command line → packages/cli/dist/am.cjs
npm run desktop                              # build and launch the client
npm run test:e2e -w am-desktop               # client end-to-end tests (Playwright, Electron mode)
npm run dist -w am-desktop                   # package an .app (apps/desktop/release/)
```

The command line also runs without the client: `node packages/cli/dist/am.cjs <command>`. After changing the canvas table, the style table or a prompt template, run `npm run generate -w @am/engine` and commit the regenerated `assets/presets` and `assets/styles`. Development rules are in `AGENTS.md` and `packages/engine/CONVENTIONS.md`.

ArticleToMotion is licensed under the [Apache License 2.0](./LICENSE). HyperFrames is an independent Apache-2.0 project installed at its pinned release by `am init`.

The `references/` of the built-in `text-to-lottie` skill are trimmed from [diffusionstudio/lottie](https://github.com/diffusionstudio/lottie) (MIT). The copyright notice and the record of what was kept, dropped, and changed live in `LICENSE` and `ATTRIBUTION.md` under `assets/shared/.agents/skills/text-to-lottie/`.

## Optional solo song explainers

Speech remains the default. `am init DIR --canvas vertical-3x4 --delivery song`
creates `song.yaml`; `am song init` adds song assets to an existing project without
overwriting different content. Song + cast and mixed speech/song are not supported.
`am run` selects the song workflow and appends its contract to explicit prompts.

1. Run `am song providers`, choose a platform with `am song configure --provider PLATFORM`,
   set the displayed environment variable locally, edit `lyrics.txt`, then run `am song doctor`.
2. Run `am song generate` (two serial candidates), or
   `am song import song.mp3 --lyrics lyrics.txt`.
3. Stop for the user to listen and run `am song select CANDIDATE`.
4. Run `am song prepare`. Review lyrics, terminology and timing; correct the draft
   if needed, then import with `am song prepare --timeline FILE --reviewed`.
5. Create integer-frame scenes covering the entire audio, then run
   `am song cues scenes/` and `am validate song`.
6. Run `am scene run-all scenes/ --song-timeline production/song/timeline.json`,
   inspect rendered frames, and concatenate the silent master.
7. Run `am song mux production/silent-master.mp4 --out final.mp4`.

For browser-based generation without API credentials, run
`am song configure --provider manual`. The song workflow writes lyrics and style,
then `am song handoff` displays copyable text and records `waiting_for_audio` in
`production/song/web-handoff.json`. Pause for the user to generate/download audio
in their chosen website and provide an attachment or a local file path. Resume in
the same conversation or with another `am run`; no idle process is required.
`am song receive AUDIO` imports with the handed-off lyric snapshot and records the
candidate, without automatically selecting or aligning it. Repeated receipt of the
same file reuses the candidate. Changed lyrics require `handoff --refresh` and a new
website generation; if the website changed the lyrics, explicitly import with
`am song import AUDIO --lyrics FINAL_LYRICS`. Manual `generate` only hands off;
media/Python dependencies are needed later for receiving/alignment.

`am song providers [PLATFORM]` provides signup/key links, access requirements and
redacted credential status without a project or network call. `configure` updates
platform fields while preserving lyrics, style and YAML comments. Supported hosted
providers are `bailian` (`DASHSCOPE_API_KEY`, Beijing workspace via `--workspace`,
Fun-Music invitation, ordinary pay-as-you-go key; currently outside Token Plan),
`elevenlabs` (`ELEVENLABS_API_KEY`, paid Music API access), `mureka` (`MUREKA_API_KEY`, pinned `mureka-9.5`, separate API credits),
`lyria` (`GEMINI_API_KEY`, `lyria-3.5`, Gemini API model access/billing),
and `fal` (`FAL_KEY`,
hosted `fal-ai/ace-step`, no deployment). Hosted `doctor` checks only key presence.
Bailian ignores style prompts when lyrics are supplied; duration/BPM controls are
not sent. ElevenLabs uses a fixed-lyrics composition plan. fal uses its own queue
protocol, distinct from native ACE-Step. Keys stay in the process environment;
explicitly append their names to `AM_PASSTHROUGH_ENV` for nested `am run` calls.
No configuration command makes paid requests or stores keys in project files.
Mureka explicitly requests one song per candidate, persists the task ID and resumes
polling without resubmission. Lyrics are limited to 5000 characters and the combined
style/instructions to 1024. Lyria uses synchronous Interactions with `store=false`
and expects one complete inline MP3 track; ambiguous calls are not retried. Duration
and BPM are creative hints. Neither provider overwrites source lyrics or reviewed
timing with model-generated text or timestamps.

MiniMax uses existing `mmx` authentication and defaults to `music-3.0`; some accounts
return HTTP 410 because music access is closed to new users. ACE-Step
uses your remote `endpoint`, defaults to `acestep-v15-turbo`, and reads credentials
only from `ACESTEP_API_KEY`. Nested calls require explicit
`AM_PASSTHROUGH_ENV=ACESTEP_API_KEY`; never put credentials in project files.
Identical requests reuse candidates. Known ACE-Step/fal/Mureka tasks resume polling/download;
ambiguous submissions are not retried. A new `--batch NAME` explicitly creates new
requests. Providers are never changed automatically.

Install Xingyu v0.6.1 (commit `e647b2f3480a9f46a027352713c8e2072d88450d`, alignment
extra) and librosa 0.11.0 in a separate Python 3.11–3.13 environment. Set `python`
in `song.yaml` to its interpreter. Follow Xingyu's model setup instructions;
`am init` does not install Python packages or model weights. Missing beat analysis
falls back to lyric-driven animation. Estimated words are excluded from word timing.
Raw alignment reports and corrections remain under `production/song/alignment/`.
Review actual sung facts and terminology; sample line-onset error target is ≤200 ms.

The complete audio includes intro, interludes and outro. Total frames are rounded
up; only the final fraction of a frame is padded with silence. No audio stretching,
extra BGM or speech ducking is applied. Changed song dependencies reject stale cues;
regenerate cues and explicitly rerender with `--force`. CI uses mock services;
real audio and visual quality require separate acceptance evidence.

## Optional: beat-synced reels without narration (in progress)

On-screen text, no voice-over, every cut on a musical downbeat. The beat grid and
bar-based scene timing are done; renderer guidance, whole-film cut review, AI-generated
instrumentals and code-synthesised scores come in later phases.

```bash
am init my-reel --canvas vertical-9x16 --delivery beat    # existing project: am beat init
python3 -m venv "$HOME/.venvs/am-beat"
"$HOME/.venvs/am-beat/bin/pip" install 'beat-this==1.1.0'  # point beat.yaml's python here
am beat doctor                       # downloads model weights on first run
am beat import track.mp3
am beat analyze                      # draft grid + click track production/beat/grid-click.wav
am beat regrid --meter 4 --anchor 1  # only if downbeats are shifted when you listen
am beat confirm                      # after listening: every accent click starts a bar
am beat bars                         # list bars, then write production/beat/plan.json
am beat cues scenes/                 # writes whole-frame durations and the beat block
am validate beat
```

`plan.json` describes scenes in bars only, e.g. `{"schema":1,"scenes":[{"id":"scene-001","bars":2}]}`;
the bars must add up to the grid. A pickup before the first downbeat joins the first scene and the
last bar runs to the end of the music. Cut frames come from one formula (downbeat seconds × fps,
rounded); durations written by `am beat cues` must not be edited by hand, and `am validate beat`
plus the pre-render check reject them if they are.

Analysis uses [beat-this](https://github.com/CPJKU/beat_this) (ISMIR 2024, MIT code and weights),
which reports beats and downbeats on CPU without madmom. Draft grids never take effect directly:
the model can shift downbeats or misjudge the meter, so listen to the click track before `confirm`.
