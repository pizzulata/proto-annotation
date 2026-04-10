# proto-annotation — Project Context

## What This Is

Design review tool for coded prototypes. A designer runs `npx proto-annotation http://localhost:3000`, their prototype opens in an iframe with an annotation overlay. They click elements, write feedback, add labels, copy an AI-ready prompt, and paste it into Cursor/Claude Code to get fixes.

Published on npm as `proto-annotation` (currently v0.3.0).
GitHub: https://github.com/pizzulata/proto-annotation

## Architecture

Single-process Node.js CLI tool. No build step, no frontend framework.

- **`bin/cli.mjs`** — CLI entry point, parses args, starts server, prints styled terminal output
- **`src/server/index.mjs`** — THE main file (~1400 lines). Express server, all HTML/CSS/JS served as template strings. Contains: `createServer()`, `buildReviewUI()`, `buildInjectScript()`, `buildDemoPage()`, `buildAgentPrompt()`, `buildJoinPage()`
- **`src/lib/store.mjs`** — In-memory annotation store + collaboration session management

Key technical decisions:
- Everything is template strings in one server file (no bundler, no build)
- Iframe injection via proxy (same-origin) for DOM inspection
- postMessage API for iframe ↔ parent communication
- WebSocket (ws library) for live sync
- No database — all in-memory
- No external AI dependencies (yet)

## Dependencies

Only three: `express`, `ws`, `open`

## Features Built (in order)

1. **Core annotation flow** — click elements, write feedback, copy AI prompt
2. **Smart contextual prompts** — `inferRelevantStyles()` reads feedback text + labels to include only relevant CSS metadata. `LABEL_FOCUS` maps labels to what the LLM should focus on
3. **Copy individual annotations** — copy prompt for one annotation at a time (not just all)
4. **Labels + type system** — Types: feedback/bug/question (mutually exclusive). Labels: additive tags like spacing, branding, typography, etc.
5. **Real-time collaboration** — `--collab` flag, invite codes, device tokens, participant avatars, live presence rings, author tracking, ownership checks

## What To Build Next

### Feature: Prompt Preview & Edit with ✨ Enhance

The big next feature. Two parts:

**1. Prompt Preview & Edit Panel**
- On each annotation card in the side panel, add a toggle/drawer to see the generated prompt for that specific annotation
- The prompt text is editable — designer can tweak wording, add details, remove things
- Edited version is what gets copied (overrides the auto-generated one)
- Copy button right there in the preview

**2. ✨ Enhance Button (inside the prompt preview panel)**
- Uses Claude API (Anthropic SDK) to rewrite the designer's feedback into a clearer, more specific instruction
- The AI has access to the element's metadata (styles, dimensions, selector, parent layout, labels) — all already captured
- Designer sees the enhanced version and can accept or revert to original
- API key passed via environment variable: `ANTHROPIC_API_KEY=sk-ant-... npx proto-annotation`

**System prompt for Enhance:**
```
You are a design-to-code translator. A designer annotated a UI element with feedback. Rewrite their feedback into a clear, specific instruction a coding AI can execute.

Rules:
- Keep the designer's intent — don't change what they want, just clarify it
- Use the element metadata (styles, dimensions, parent layout) to add specifics
- Be concise — 1-3 sentences max
- Use exact values (px, colors, properties) when relevant
- Never add opinions or suggestions the designer didn't imply
- Output only the rewritten feedback, nothing else
```

**Flow:**
```
Annotation card → click to expand prompt preview
        ↓
See the generated prompt (read-only by default)
        ↓
Two actions: ✨ Enhance  |  ✏️ Edit
        ↓
Enhance: AI rewrites → accept or revert
Edit: becomes editable textarea → designer tweaks manually
        ↓
Copy button right there
```

### Future Roadmap (after Enhance)
- Figma link attachments (attach a Figma frame to annotation — "should look like this")
- Screenshot capture (before/after per annotation)
- SQLite persistence (annotations survive server restarts)
- AI Design Audit (scan page for accessibility/spacing/contrast issues proactively)

## Key Design Decisions

- **Designer stays in control** — no auto-sending to AI tools, no MCP server mode. Copy-paste is intentional because designers want to verify each fix one at a time
- **No intermediary LLM for prompt generation** — raw designer voice + structured metadata is better than LLM-rephrased corporate speak. The Enhance button is optional, not default
- **No accounts/passwords for collab** — invite code is the gate, device token is identity, localStorage persistence
- **Prompts are contextual, not data dumps** — feedback about spacing only includes padding/margin/gap, not every CSS property

## Common Issues

- **Port 4747 in use**: `lsof -ti :4747 | xargs kill -9`
- **Node not found in some contexts**: use absolute path `/usr/local/bin/node`
- **Template literal escaping**: the server file uses nested template strings. Browser-side JS uses `\${...}`, Node-side uses `${...}`. Inline onclick handlers cause escaping nightmares — use `data-action` + `addEventListener` instead
- **npm publish needs 2FA**: use `npm publish --otp=CODE` or browser auth flow

## How To Run

```bash
# Development
node bin/cli.mjs                                    # demo mode
node bin/cli.mjs http://localhost:3000              # proxy a prototype
node bin/cli.mjs --collab                           # collaborative mode
node bin/cli.mjs --collab http://localhost:3000     # collab + prototype

# Publishing
npm version patch/minor/major
npm publish
```
