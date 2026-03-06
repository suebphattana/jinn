"use client";
import { useState, useCallback, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useGateway } from "@/hooks/use-gateway";
import { ChatSidebar } from "@/components/chat/chat-sidebar";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ChatInput } from "@/components/chat/chat-input";

interface Message {
  role: "user" | "assistant";
  content: string;
  engine?: string;
  model?: string;
}

const ONBOARDING_PROMPT = `This is your first time being activated. The user just set up Jimmy and opened the web dashboard for the first time.

Read your CLAUDE.md instructions and the onboarding skill at ~/.jimmy/skills/onboarding/SKILL.md, then follow the onboarding flow:
- Greet the user warmly and introduce yourself as Jimmy
- Briefly explain what you can do (manage cron jobs, hire AI employees, connect to Slack, etc.)
- Check if ~/.openclaw/ exists and mention migration if so
- Ask the user what they'd like to set up first`;

export default function ChatPageWrapper() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen text-neutral-400">Loading...</div>}>
      <ChatPage />
    </Suspense>
  );
}

function ChatPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const { events } = useGateway();
  const searchParams = useSearchParams();
  const onboardingTriggered = useRef(false);

  // Auto-trigger onboarding on first visit
  useEffect(() => {
    if (onboardingTriggered.current) return;

    const shouldOnboard = searchParams.get("onboarding") === "1";

    if (shouldOnboard) {
      onboardingTriggered.current = true;
      triggerOnboarding();
    } else {
      // Also check via API in case user navigated directly to /chat
      api.getOnboarding().then((data) => {
        if (data.needed && !onboardingTriggered.current) {
          onboardingTriggered.current = true;
          triggerOnboarding();
        }
      }).catch(() => {});
    }
  }, [searchParams]);

  function triggerOnboarding() {
    setMessages([{
      role: "assistant",
      content: "Starting up for the first time...",
    }]);
    setLoading(true);

    api.createSession({
      source: "web",
      prompt: ONBOARDING_PROMPT,
    }).then((session) => {
      const id = String((session as Record<string, unknown>).id);
      setSelectedId(id);
      setRefreshKey((k) => k + 1);
      // Result will come via WebSocket session:completed event
    }).catch((err) => {
      setLoading(false);
      setMessages([{
        role: "assistant",
        content: `Failed to start onboarding: ${err instanceof Error ? err.message : "Unknown error"}`,
      }]);
    });
  }

  // Listen for session:completed events to update
  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[events.length - 1];
    if (latest.event === "session:completed") {
      const payload = latest.payload as Record<string, unknown>;
      // Match by selectedId or pick up the session if we're waiting for onboarding
      const matchesSession = selectedId && payload.sessionId === selectedId;
      const isOnboarding = !selectedId && onboardingTriggered.current;
      if (matchesSession || isOnboarding) {
        if (isOnboarding && payload.sessionId) {
          setSelectedId(String(payload.sessionId));
        }
        setLoading(false);
        if (payload.result) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant" as const, content: String(payload.result) },
          ]);
        }
        if (payload.error && !payload.result) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant" as const, content: `Error: ${payload.error}` },
          ]);
        }
        setRefreshKey((k) => k + 1);
      }
    }
  }, [events, selectedId]);

  const loadSession = useCallback(async (id: string) => {
    try {
      const session = (await api.getSession(id)) as Record<string, unknown>;
      const history = session.messages || session.history || [];
      if (Array.isArray(history)) {
        setMessages(
          history.map((m: Record<string, unknown>) => ({
            role: (m.role as "user" | "assistant") || "assistant",
            content: String(m.content || m.text || ""),
            engine: m.engine ? String(m.engine) : undefined,
            model: m.model ? String(m.model) : undefined,
          }))
        );
      }
      // Check if session is currently running
      if (session.status === "running") {
        setLoading(true);
      }
    } catch {
      setMessages([]);
    }
  }, []);

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      setMessages([]);
      setLoading(false);
      loadSession(id);
    },
    [loadSession]
  );

  const handleNewChat = useCallback(() => {
    setSelectedId(null);
    setMessages([]);
    setLoading(false);
  }, []);

  const handleSend = useCallback(
    async (message: string) => {
      // Don't show the raw onboarding prompt as a user message
      const isOnboardingMsg = message === ONBOARDING_PROMPT;
      if (!isOnboardingMsg) {
        const userMsg: Message = { role: "user", content: message };
        setMessages((prev) => [...prev, userMsg]);
      }
      setLoading(true);

      try {
        let sessionId = selectedId;

        if (!sessionId) {
          // Create a new session — API returns immediately, result comes via WebSocket
          const session = (await api.createSession({
            source: "web",
            prompt: message,
          })) as Record<string, unknown>;
          sessionId = String(session.id);
          setSelectedId(sessionId);
          setRefreshKey((k) => k + 1);
          // Wait for session:completed WebSocket event (handled in useEffect above)
        } else {
          // Send message to existing session — result comes via WebSocket
          await api.sendMessage(sessionId, { message });
          setRefreshKey((k) => k + 1);
          // Wait for session:completed WebSocket event
        }
      } catch (err) {
        setLoading(false);
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant" as const,
            content: `Error: ${err instanceof Error ? err.message : "Failed to send message"}`,
          },
        ]);
      }
    },
    [selectedId]
  );

  const handleStatusRequest = useCallback(async () => {
    if (!selectedId) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant" as const,
          content: "No active session. Send a message to start one.",
        },
      ]);
      return;
    }

    try {
      const session = (await api.getSession(selectedId)) as Record<
        string,
        unknown
      >;
      const info = [
        `**Session Info**`,
        `ID: \`${session.id}\``,
        `Status: ${session.status || "unknown"}`,
        session.employee ? `Employee: ${session.employee}` : null,
        session.engine ? `Engine: ${session.engine}` : null,
        session.model ? `Model: ${session.model}` : null,
        session.createdAt ? `Created: ${session.createdAt}` : null,
      ]
        .filter(Boolean)
        .join("\n");

      setMessages((prev) => [
        ...prev,
        { role: "assistant" as const, content: info },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant" as const,
          content: "Failed to fetch session status.",
        },
      ]);
    }
  }, [selectedId]);

  return (
    <div
      className="flex -m-8"
      style={{ height: "calc(100vh)" }}
    >
      {/* Sidebar */}
      <div className="w-[250px] flex-shrink-0">
        <ChatSidebar
          selectedId={selectedId}
          onSelect={handleSelect}
          onNewChat={handleNewChat}
          refreshKey={refreshKey}
        />
      </div>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col bg-white">
        {/* Header */}
        <div className="px-4 py-3 border-b border-neutral-200 bg-white">
          <h2 className="text-sm font-medium text-neutral-800">
            {selectedId ? `Session ${selectedId.slice(0, 8)}...` : "New Chat"}
          </h2>
        </div>

        {/* Messages */}
        <ChatMessages messages={messages} loading={loading} />

        {/* Input */}
        <ChatInput
          disabled={loading}
          onSend={handleSend}
          onNewSession={handleNewChat}
          onStatusRequest={handleStatusRequest}
        />
      </div>
    </div>
  );
}
