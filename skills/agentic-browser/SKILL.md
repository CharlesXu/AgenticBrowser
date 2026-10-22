---
name: agentic-browser
description: Operate one explicitly authorized task Space in the local AgenticBrowser PoC through MCP; observe, claim, navigate, input, release, and resume after human or remote handoff.
metadata:
  version: "0.2.0"
---

# AgenticBrowser Space

Use the `agentic-browser-space` MCP server configured with a **single-Space** connection file. Each MCP process can access either `task-a` or `task-b`; it cannot access Main Space or change its own scope.

Read the MCP resource `agentic-browser://guide` when connecting. It is this guide shipped with the running adapter, not documentation fetched from a different release. Use `tools/list` for exact parameter schemas; do not infer Ego, Playwright, CDP, or DOM APIs from similar names.

## Setup

Start the project browser with `npm run spaces`. Its launcher supplies separate private connection files for A and B. Configure your Harness to launch:

```text
node /absolute/project/path/src/mcp.ts --connection /absolute/path/to/task-a.json
```

Use the B file in a separate MCP instance for another Harness. Do not provide the full Profile discovery file, copy credentials into prompts, or expose the local native endpoint publicly. This Skill does not install or change global Harness settings.

## Minimal workflow

Use the same authorized Space for the entire goal and across rounds. Reuse its current page. A failed navigation, timeout, or lost control is not a reason to create another Space, switch profiles, or repeat completed actions. JavaScript variables in a Harness are not durable browser state: obtain the current tab from `space_observe` after navigation or a tab change.

1. Call `space_list` and `space_observe`. Work only in the returned task Space. Reading metadata does not acquire control.
2. Call `space_claim`. Retain its `lease` and `generation` inside this task session; never log or publish them.
3. Supply that lease/generation and the current `tab` from observe for navigation, click, type, or scroll. Coordinates are viewport CSS pixels. `dispatched` means input was sent, not that the intended page effect occurred; check the page or current observation before advancing.
4. On `stale_control`, `already_claimed`, or human/remote ownership, stop sending input. Do not keep retrying a claim to overtake another controller. When the user needs to act, call `space_handoff` with the current lease/generation and end the action loop. Keep the previous lease privately as the proof needed to resume; handoff preserves tabs and does not switch the user's visible workspace.
5. When state becomes `awaiting-resume`, call `space_resume` with the **previous** lease. Use the returned **new** lease/generation in `space_observe`; only then resume actions with the current tab. An observer without the new lease cannot clear this gate.
6. Call `space_release` on completion and wait for the result before reporting success. It preserves tabs. Do not release or claim again while waiting for the user to return control. On normal stdio EOF or termination, the adapter attempts to release only its own lease; forced process termination cannot guarantee cleanup.

## Observe, act, verify

- `space_observe` returns selected-tab metadata and ownership. It is **not** Ego's semantic snapshot, DOM content, a screenshot, or an input-focus assertion.
- Choose coordinates only from an authorized current visual observation or the controlled fixture's reported geometry. Observe after changes that could alter the target. Do not guess page targets from a URL or tool success alone.
- A navigation/action receipt reports dispatch, not business completion. Wait for an observable expected result with a finite deadline; do not blindly repeat actions or rely on a long fixed sleep. Group only steps whose intermediate results cannot change the next action.
- Stop once the requested result is visible. Do not verify the same result through multiple surfaces by default.
- Use the current tab and CSS viewport coordinates for MCP input. VNC canvas pixels include scaling/letterboxing and must not be copied directly into MCP coordinates.

| Situation | Next step |
|---|---|
| `available` | Claim this same authorized Space, then observe with the lease. |
| `human` / `remote` | Stop input. Wait for explicit return; do not steal control. |
| `awaiting-resume` | Resume with the previous lease, then observe with the returned new lease/generation. |
| Stale tab or unknown action outcome | Observe the same Space and inspect the actual page before deciding on a retry. |
| Task complete | Release the current lease; retain the page for the user. |

MCP input and VNC input share the browser’s control checks. VNC viewing does not grant input permission; remote takeover/return uses the viewer’s explicit controls. Main Space remains human-only. This PoC does not expose arbitrary JavaScript, global CDP, filesystem access, extension popups, or a model service through MCP.

Reference: [official MCP TypeScript SDK stdio documentation](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html).

Workflow references: [Ego's version-matched guide](https://github.com/citrolabs/ego-lite/blob/main/docs/ego-browser-skill-command.md), [TaskSpace/Page usage](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/skill-body/SKILL.md), and [lifecycle implementation](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/src/page-model.ts), reviewed 2026-10-23. We adopt task continuity, explicit handoff, bounded observation and result verification. Ego's Node SDK is not an MCP server to copy directly; its arbitrary evaluation, raw CDP, snapshots, full tab APIs, and automatic page closure are not implemented or authorized by this PoC.
