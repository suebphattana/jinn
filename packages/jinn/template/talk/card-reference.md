# AURA card reference

The voice persona keeps only the most common card inline. This file holds the full 13-type card catalogue, the delegation endpoint, the update/dismiss/clear endpoints, and how card taps return to you.

Post every card to YOUR OWN talk session id (`<YOUR_OWN_SESSION_ID>` from your "Current session" context) — the card surface belongs to the voice session the operator is watching, NOT the COO child.

## Pushing & updating
- Push: `POST <GATEWAY_URL>/api/talk/card` with body `{"sessionId":"<YOUR_OWN_SESSION_ID>","card":{…}}`. Every card needs a stable string `id` and a `type`. Re-post the SAME id to update it in place (e.g. bump a status from running to done).
- Patch one card: `POST <GATEWAY_URL>/api/talk/card/update` body `{"sessionId":"<YOUR_OWN_SESSION_ID>","cardId":"<id>","patch":{…}}`.
- Drop one card: `POST <GATEWAY_URL>/api/talk/card/dismiss` body `{"sessionId":"<YOUR_OWN_SESSION_ID>","cardId":"<id>"}`.
- Wipe the surface for a fresh topic: `POST <GATEWAY_URL>/api/talk/card/clear` body `{"sessionId":"<YOUR_OWN_SESSION_ID>"}`.

## Delegation — the only way to hand work to the COO

`POST <GATEWAY_URL>/api/talk/delegate` is your ONLY delegation surface. Never call `/api/sessions` directly.

**Request body:**
```json
{"sessionId":"<YOUR_OWN_SESSION_ID>","thread":"new","label":"<short topic>","brief":"<expanded brief>"}
```
- `thread`: `"new"` to start a fresh COO thread, or an existing thread id from your roster to continue it.
- `label`: short 1–3 word topic label (only needed when `thread:"new"`).
- `brief`: the full expanded brief — goal, constraints, what done looks like.

**Success response:** `{"ok":true,"threadId":"<COO_SESSION_ID>","created":true|false}`

**Error (400) with unknown thread id:** returns `{"error":"…","threads":[…]}` — the valid roster. Correct yourself from it and retry.

## All 13 card types

### text
One short thing that genuinely reads better than it's heard (an address, a code snippet, a one-line quote):
```json
{"id":"addr","type":"text","title":"Office address","body":"123 Main St, Floor 4","tldr":"Floor 4"}
```

### stat
A single metric with optional trend delta:
```json
{"id":"mrr","type":"stat","label":"MRR","value":"€4,200","delta":{"dir":"up","value":"+12%"}}
```
`delta.dir`: `"up"` | `"down"` | `"flat"`

### list
An ordered or unordered list of items, each optionally checkable:
```json
{"id":"todo","type":"list","title":"Next steps","ordered":true,"items":[{"text":"Deploy to staging"},{"text":"QA smoke test","done":false}]}
```

### image
A single image with optional alt text and caption:
```json
{"id":"preview","type":"image","src":"https://example.com/img.png","alt":"Dashboard preview","caption":"Latest build"}
```

### image-grid
Multiple images in a grid:
```json
{"id":"frames","type":"image-grid","title":"Video frames","images":[{"src":"https://example.com/a.png","alt":"Frame 1"},{"src":"https://example.com/b.png","alt":"Frame 2"}]}
```

### status
A single delegated job in flight (`state`: queued|running|done|error, `progress` 0..1):
```json
{"id":"content-pipeline","type":"status","label":"Content pipeline","progress":0.4,"state":"running","chips":["phase 2"]}
```
Bump the same id to `"done"` and then clear it when finished.

### agent-activity
Several employees working concurrently:
```json
{"id":"team-run","type":"agent-activity","title":"Research sprint","agents":[{"id":"a1","name":"content-lead","role":"writer","status":"running","detail":"drafting","progress":0.5},{"id":"a2","name":"seo-lead","role":"analyst","status":"queued"}]}
```

### link
ALWAYS use when you mention or the operator asks for a URL — never speak a URL aloud:
```json
{"id":"docs-link","type":"link","url":"https://example.com/docs","label":"The doc you asked for","source":"docs.example.com"}
```

### choice
Two or more viable paths for the operator to pick (tap returns a `choose` action):
```json
{"id":"deploy-where","type":"choice","prompt":"Where to deploy?","options":[{"id":"prod","label":"Production","detail":"live users","badge":"RISKY"},{"id":"staging","label":"Staging","detail":"safe"}]}
```

### comparison
Side-by-side comparison table:
```json
{"id":"plan-compare","type":"comparison","title":"Plan options","columns":["Free","Pro"],"rows":[{"label":"Price","cells":["€0","€29"]},{"label":"Seats","cells":["1","10"],"highlight":1}]}
```

### approval
ALWAYS before any side-effectful or irreversible action (send, deploy, payment, delete, publish). Never act on voice alone:
```json
{"id":"send-email","type":"approval","summary":"Send the draft email?","details":[{"k":"To","v":"client@example.com"},{"k":"Subject","v":"Proposal v2"}],"confirmLabel":"Send it","rejectLabel":"Hold","danger":true}
```

### keyvalue
A set of labelled key-value rows with optional tone:
```json
{"id":"order-info","type":"keyvalue","title":"Order #1234","rows":[{"k":"Status","v":"Paid","tone":"good"},{"k":"Amount","v":"€149"},{"k":"Refundable","v":"No","tone":"bad"}]}
```

### diff
Before/after diff hunks:
```json
{"id":"config-diff","type":"diff","title":"Config change","hunks":[{"label":"timeout","before":"30s","after":"60s"}]}
```

## Reading a tap back
A tap arrives as a normal user message you must interpret, then act on in one short spoken line:
- `[card-action card=<id> action=approve] …` → approved → proceed with / tell the COO to execute the prepared action.
- `[card-action card=<id> action=reject] …` → declined → do NOT execute; acknowledge and stop.
- `[card-action card=<id> action=choose option=<optionId>] …` → he picked that option → continue down that path (route the follow-up to the right COO thread).

Once acted on, update or clear the card (re-post the same `id`, or clear the surface).

## Naming a thread
Give a COO child a clean 1–3 word topic so it's recognisable on screen:
`POST <GATEWAY_URL>/api/talk/thread/label` body `{"sessionId":"<YOUR_OWN_SESSION_ID>","threadId":"<COO_SESSION_ID>","label":"Research"}` — `sessionId` is your own (the surface); `threadId` is the COO child's id.
