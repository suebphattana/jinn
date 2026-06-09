# AURA card reference

The voice persona keeps only the common `status` card inline. This file holds the full card catalogue, the update/dismiss/clear + thread-label endpoints, and how card taps return to you.

Post every card to YOUR OWN talk session id (`<YOUR_OWN_SESSION_ID>` from your "Current session" context) — the card surface belongs to the voice session the operator is watching, NOT the COO child.

## Pushing & updating
- Push: `POST <GATEWAY_URL>/api/talk/card` with body `{"sessionId":"<YOUR_OWN_SESSION_ID>","card":{…}}`. Every card needs a stable string `id` and a `type`. Re-post the SAME id to update it in place (e.g. bump a status from running to done).
- Patch one card: `POST <GATEWAY_URL>/api/talk/card/update` body `{"sessionId":"<YOUR_OWN_SESSION_ID>","cardId":"<id>","patch":{…}}`.
- Drop one card: `POST <GATEWAY_URL>/api/talk/card/dismiss` body `{"sessionId":"<YOUR_OWN_SESSION_ID>","cardId":"<id>"}`.
- Wipe the surface for a fresh topic: `POST <GATEWAY_URL>/api/talk/card/clear` body `{"sessionId":"<YOUR_OWN_SESSION_ID>"}`.

The voice surface is deliberately narrow — a card earns its place only when there's something to **DO** or a job to **WATCH**. These five types are the whole catalogue; anything else (list, stat, link, image, comparison, keyvalue, diff) is rejected by the gateway. Speak the one-line headline and let the COO thread or /chat hold the depth.

## WATCH — a job in flight
- **status** — a single delegated job: `{"id":"…","type":"status","label":"Content pipeline","progress":0.4,"state":"running","chips":["phase 2"]}` (`state`: queued|running|done|error, `progress` 0..1). Bump the same id to `"done"` and then clear it when finished.
- **agent-activity** — the rarer case, several employees working at once: `{"id":"…","type":"agent-activity","title":"…","agents":[{"id":"a1","name":"content-lead","role":"writer","status":"running","detail":"drafting","progress":0.5}]}`.

## DO — the operator taps; the tap returns to you as a message
- **approval** — ALWAYS for a side-effectful or irreversible action (send, deploy, payment, delete, publish); never act on voice alone: `{"id":"send-email","type":"approval","summary":"Send the draft email?","details":[{"k":"To","v":"client@example.com"},{"k":"Subject","v":"Proposal v2"}],"confirmLabel":"Send it","rejectLabel":"Hold","danger":true}`
- **choice** — two or more viable paths: `{"id":"deploy-where","type":"choice","prompt":"Where to deploy?","options":[{"id":"prod","label":"Production","detail":"live users","badge":"RISKY"},{"id":"staging","label":"Staging","detail":"safe"}]}`

## The read valve — use sparingly
- **text** — one short thing that genuinely reads better than it's heard (an address, a code, a one-line quote): `{"id":"…","type":"text","title":"OPTIONAL EYEBROW","body":"prose","tldr":"optional one-liner"}`. NOT for lists, tables, or prose dumps — speak those.

## Reading a tap back
A tap arrives as a normal user message you must interpret, then act on in one short spoken line:
- `[card-action card=<id> action=approve] …` → approved → proceed with / tell the COO to execute the prepared action.
- `[card-action card=<id> action=reject] …` → declined → do NOT execute; acknowledge and stop.
- `[card-action card=<id> action=choose option=<optionId>] …` → he picked that option → continue down that path (route the follow-up to the right COO thread).

Once acted on, update or clear the card (re-post the same `id`, or clear the surface).

## Naming a thread
Give a COO child a clean 1–3 word topic so it's recognisable on screen:
`POST <GATEWAY_URL>/api/talk/thread/label` body `{"sessionId":"<YOUR_OWN_SESSION_ID>","threadId":"<COO_SESSION_ID>","label":"Research"}` — `sessionId` is your own (the surface); `threadId` is the COO child's id.

## List your threads
`GET <GATEWAY_URL>/api/sessions/<YOUR_OWN_SESSION_ID>/children`.
