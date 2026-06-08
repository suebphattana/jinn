/**
 * Jinn Talk — CardStack render test.
 *
 * Proves the orphaned-no-more card surface actually renders the card payloads
 * the orchestrator pushes over `talk:card`. One real example of each common
 * type (status, list, stat, link, agent-activity, text) is mounted and its key
 * content is asserted present in the DOM — the same `Card` shapes the backend
 * validates and the WS event delivers.
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { CardStack } from "../card-stack"
import type { Card } from "../../types"

const CARDS: Card[] = [
  {
    id: "content-blog",
    type: "status",
    title: "DELEGATED",
    label: "Content blog pipeline",
    progress: 0.4,
    state: "running",
    chips: ["phase 2"],
  },
  {
    id: "todo",
    type: "list",
    title: "TODAY",
    items: [{ text: "Ship cards", done: true }, { text: "Review PR" }],
  },
  {
    id: "mrr",
    type: "stat",
    value: "€3.4K",
    label: "June MRR",
    delta: { dir: "up", value: "+12%" },
  },
  {
    id: "dash",
    type: "link",
    url: "https://example.com/dashboard",
    label: "Open dashboard",
  },
  {
    id: "agents",
    type: "agent-activity",
    agents: [
      { id: "a1", name: "content-lead", role: "writer", status: "running", detail: "drafting", progress: 0.5 },
    ],
  },
]

describe("CardStack", () => {
  it("renders each common card type's content", () => {
    render(<CardStack cards={CARDS} />)

    // status card
    expect(screen.getByText("Content blog pipeline")).toBeTruthy()
    expect(screen.getByText("Running")).toBeTruthy()
    expect(screen.getByText("phase 2")).toBeTruthy()
    // list card
    expect(screen.getByText("Ship cards")).toBeTruthy()
    expect(screen.getByText("Review PR")).toBeTruthy()
    // stat card
    expect(screen.getByText("€3.4K")).toBeTruthy()
    expect(screen.getByText("+12%")).toBeTruthy()
    // link card — rendered as an anchor to its url
    const link = screen.getByText("Open dashboard").closest("a")
    expect(link?.getAttribute("href")).toBe("https://example.com/dashboard")
    // agent-activity card
    expect(screen.getByText("content-lead")).toBeTruthy()
    expect(screen.getByText("drafting")).toBeTruthy()
  })

  it("renders nothing when there are no cards", () => {
    const { container } = render(<CardStack cards={[]} />)
    // The deck mounts but holds no card shells.
    expect(container.querySelectorAll(".jt-card").length).toBe(0)
  })

  it("renders the decision-support variants' content", () => {
    const cards: Card[] = [
      {
        id: "choose",
        type: "choice",
        prompt: "Where to deploy?",
        options: [
          { id: "prod", label: "Production", detail: "live users" },
          { id: "staging", label: "Staging" },
        ],
      },
      {
        id: "cmp",
        type: "comparison",
        columns: ["Free", "Pro"],
        rows: [{ label: "Seats", cells: ["1", "5"], highlight: 1 }],
      },
      {
        id: "appr",
        type: "approval",
        summary: "Send the invoice?",
        details: [{ k: "Amount", v: "€100" }],
        danger: true,
      },
      { id: "kv", type: "keyvalue", rows: [{ k: "Uptime", v: "99.9%", tone: "good" }] },
      { id: "df", type: "diff", hunks: [{ label: "interest", before: "old", after: "new" }] },
    ]
    render(<CardStack cards={cards} />)
    expect(screen.getByText("Where to deploy?")).toBeTruthy()
    expect(screen.getByText("Production")).toBeTruthy()
    expect(screen.getByText("Seats")).toBeTruthy()
    expect(screen.getByText("Send the invoice?")).toBeTruthy()
    expect(screen.getByText("€100")).toBeTruthy()
    expect(screen.getByText("99.9%")).toBeTruthy()
    expect(screen.getByText("old")).toBeTruthy()
    expect(screen.getByText("new")).toBeTruthy()
  })

  it("fires onAction with the machine-tagged message when a choice option is tapped", () => {
    const onAction = vi.fn()
    const cards: Card[] = [
      {
        id: "deploy-where",
        type: "choice",
        options: [{ id: "prod", label: "Production" }],
      },
    ]
    render(<CardStack cards={cards} onAction={onAction} />)
    fireEvent.click(screen.getByText("Production"))
    expect(onAction).toHaveBeenCalledWith(
      "[card-action card=deploy-where action=choose option=prod] Production",
    )
  })

  it("fires onAction for approve / reject on an approval card", () => {
    const onAction = vi.fn()
    const cards: Card[] = [
      { id: "send-it", type: "approval", summary: "Send?", confirmLabel: "Send it", rejectLabel: "Hold" },
    ]
    render(<CardStack cards={cards} onAction={onAction} />)
    fireEvent.click(screen.getByText("Send it"))
    fireEvent.click(screen.getByText("Hold"))
    expect(onAction).toHaveBeenNthCalledWith(1, "[card-action card=send-it action=approve] Send it")
    expect(onAction).toHaveBeenNthCalledWith(2, "[card-action card=send-it action=reject] Hold")
  })
})
