# Skill Invocation — How `<dir>/<skill>/SKILL.md` Becomes a Tool

> Reverse-engineered from `cli.js` v0.2.90. See
> [`cli-anchors.md`](./cli-anchors.md) for anchors used.

## TL;DR

1. Skills are **discovered at startup**: cli.js scans
   `<root>/<skill-name>/SKILL.md` files under multiple roots, parses
   frontmatter, builds an in-memory `Skill` object.
2. The "Skill" tool — a single built-in `tool_use.name = "Skill"` — is
   how the model picks one. `input.skill` names the skill.
3. Invoking a skill **doesn't return a tool_result**. The skill's
   `markdownContent` is injected into the system-prompt budget for the
   next turn(s) so the model continues from there.
4. Per-skill `model` and `effort` overrides are honoured for the
   subsequent turn — so calling a haiku-bound skill from an opus
   session temporarily switches models.

---

## 1. Frontmatter schema

cli.js function `Gt1` (frontmatter → skill metadata):

```js
function buildSkillMeta(frontmatter, content, name, kind = "Skill") {
  const description = frontmatter.description ?? firstParagraph(content);
  const userInvocable = frontmatter["user-invocable"] === undefined
                          ? true
                          : !!frontmatter["user-invocable"];
  const model = frontmatter.model === "inherit"
                  ? undefined
                  : (frontmatter.model ? resolveModel(frontmatter.model) : undefined);
  const effort = frontmatter.effort;
  const effortResolved = effort !== undefined ? toEffortLevel(effort) : undefined;
  if (effort !== undefined && effortResolved === undefined) {
    warn(`Skill ${name} has invalid effort '${effort}'. Valid: low|medium|high|max or int`);
  }
  return { description, userInvocable, model, effort: effortResolved, … };
}
```

Recognised keys:

```yaml
---
name: my-skill                  # filename takes precedence if missing
description: …                  # trigger hint shown to the model
user-invocable: true | false    # default true; if false, model only
model: inherit | <id>           # per-skill model override
effort: low | medium | high | max | <int>  # thinking budget
---

Body becomes the system prompt patch.
```

Unrecognised keys are silently ignored. Anchors: `Gt1`, `vt1`.

## 2. Loading roots & order

cli.js function in module around offset 9.6MB:

```js
// Simplified
async function loadAllSkills(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const directories = entries.filter(e => e.isDirectory() || e.isSymbolicLink())
                              .map(e => e.name);
  const valid = await Promise.all(directories.map(async (name) => {
    try {
      await stat(join(dir, name, "SKILL.md"));
      return name;
    } catch { return null; }
  }));
  return valid.filter(Boolean);
}
```

Lookup order (matches discovery dirs we documented):

```
~/.claude/plugins/<plugin>/skills/<skill>/SKILL.md  (plugin)
~/.claude/skills/<skill>/SKILL.md                    (user)
<cwd>/.claude/skills/<skill>/SKILL.md                (project)
```

Conflicts resolved by **deduplication on `skillName`** — project wins
over user wins over plugin (last-write-wins in the merging step,
opposite to the discovery order shown).

After loading, cli.js emits the `skill_listing` system event:

```js
{ type: "system", subtype: "skill_listing",
  skillCount: number, displayPath: string, … }
```

We currently ignore it; surfacing it would let the TUI show "Loaded N
skills from <path>" on session start.

## 3. The `Skill` tool — invocation path

The model's tool definitions include a single `Skill` entry. The model
emits, in an assistant message:

```json
{
  "type": "tool_use",
  "id": "tu_skill_abc",
  "name": "Skill",
  "input": {
    "skill": "dev-discipline:tdd-guide",
    "args": "optional free-form argument string"
  }
}
```

cli.js handler (paraphrased):

```js
async function invokeSkill(toolUse) {
  const meta = skillRegistry.get(toolUse.input.skill);
  if (!meta) return error("skill not found");
  if (!meta.userInvocable && callerIsUser()) return error("not user-invocable");

  // Patch the system prompt for the next turn(s).
  patchSystemPrompt(meta.markdownContent);

  // Apply per-skill overrides for the next turn.
  if (meta.model) overrideModel(meta.model);
  if (meta.effort) overrideEffort(meta.effort);

  // Do NOT emit a tool_result. The Skill "completes" by changing
  // future-turn context; the loop continues directly into the next
  // model call with the new prompt budget.
}
```

This is why we observe — and noted in the tool-dispatch doc — that a
`Skill` `tool_use` row stays `⏺` indefinitely: there is no matching
`tool_result` to flip it to `✓`. The "completion" happens when the
next assistant message arrives.

## 4. Plugin-namespaced skill IDs

Skills bundled with plugins use a colon namespace:

- `dev-discipline:tdd-guide` (from `~/.claude/plugins/dev-discipline/`)
- `plugin-dev:hook-development` (from plugin `plugin-dev`)
- Bare `pickup`, `verify`, `e2e` (top-level user / built-in skills)

cli.js builds these IDs in `vt1`, joining the `source` prefix with the
`skillName` via `:`. We use the dedup-by-name in `discoverSkills`; we
should also recognise plugin-prefixed IDs (currently we'd lose them
because plugins/<x>/skills/<y> only stores `y` as the name).

## 5. Effort & model overrides — subtle effect

```yaml
# ~/.claude/skills/test-runner/SKILL.md
---
name: test-runner
model: claude-haiku-4-5
effort: low
description: Run the project's test suite and summarise.
---
Run `bun test` and report pass/fail counts.
```

When the **opus**-driven main session invokes this skill, the *next*
turn runs on **haiku** with **low** effort. This is how the official
CLI keeps cost down for routine work — and is the exact mechanism we'd
need to replicate in our `ContextManager` / model-router optimize utils
to deliver the same savings.

We don't expose any way to plumb skill-level overrides today. They are
honoured automatically by cli.js — but we have no visibility into
"this turn switched models" so our cost / spinner / model badge are
stale during that turn.

## 6. Action items for claude-sdk

| Action | Effort | Priority |
|---|---|---|
| Stop showing dangling `⏺` for Skill rows — flip to ✓ on `assistant-end` after the skill call | trivial | HIGH |
| Read frontmatter `model` + `effort` in `discoverSkills` and expose them in the popup description | small | MED |
| Surface the `skill_listing` event in TUI as `Loaded N skills` line | trivial | MED |
| Honour plugin-prefixed skill IDs (`<plugin>:<name>`) in our discovery dedup | small | LOW |
| Detect when the active turn is running on a different model (skill-override) and update the badge | medium | LOW |

## 7. Open questions

- How long does the skill-prompt patch persist? Just the next turn, the
  rest of the session, or until another skill fires?
- Can a skill chain into other skills? (i.e. does the patched system
  prompt allow another Skill tool_use inside?)
- The `effort` integer values — what range does cli.js accept? Spec
  says `low|medium|high|max|<int>` but the int range is unclear.
- Is there a difference between the public `Skill` tool path and
  internal `loadSkill` plumbing used for the `/<skill>` slash variant?

## 8. References

- cli.js v0.2.90 (anchors: `"SKILL.md"`, `"Skill"`, `"skill_listing"`,
  function `Gt1`, function `vt1`)
- Our discovery: `src/cli/discover.ts` (`discoverSkills`)
- Our render: `cmd/tui/main.go` (`renderSkillCall`)
- Frontmatter examples: `~/.claude/skills/*/SKILL.md`,
  `~/.claude/plugins/*/skills/*/SKILL.md`
