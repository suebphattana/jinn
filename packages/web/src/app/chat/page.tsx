"use client";
import { useState, useCallback, useEffect } from "react";
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

export default function ChatPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const { events } = useGateway();

  // Listen for session:completed events to update
  useEffect(() => {
    if (events.length === 0 || !selectedId) return;
    const latest = events[events.length - 1];
    if (latest.event === "session:completed") {
      const payload = latest.payload as Record<string, unknown>;
      if (payload.sessionId === selectedId) {
        setLoading(false);
        // Refresh the session to get updated messages
        loadSession(selectedId);
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
      // Add user message to UI immediately
      const userMsg: Message = { role: "user", content: message };
      setMessages((prev) => [...prev, userMsg]);
      setLoading(true);

      try {
        let sessionId = selectedId;

        if (!sessionId) {
          // Create a new session
          const session = (await api.createSession({
            source: "web",
            message,
          })) as Record<string, unknown>;
          sessionId = String(session.id);
          setSelectedId(sessionId);
          setRefreshKey((k) => k + 1);

          // Check response for assistant message
          const result = session.result || session.response;
          if (result) {
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant" as const,
                content: String(
                  typeof result === "object"
                    ? (result as Record<string, unknown>).content ||
                        (result as Record<string, unknown>).text ||
                        JSON.stringify(result)
                    : result
                ),
                engine: session.engine ? String(session.engine) : undefined,
                model: session.model ? String(session.model) : undefined,
              },
            ]);
            setLoading(false);
          }
          // If no result yet, WebSocket will notify when done
        } else {
          // Send message to existing session
          const response = (await api.sendMessage(sessionId, {
            message,
          })) as Record<string, unknown>;

          const result = response.result || response.response;
          if (result) {
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant" as const,
                content: String(
                  typeof result === "object"
                    ? (result as Record<string, unknown>).content ||
                        (result as Record<string, unknown>).text ||
                        JSON.stringify(result)
                    : result
                ),
                engine: response.engine
                  ? String(response.engine)
                  : undefined,
                model: response.model ? String(response.model) : undefined,
              },
            ]);
            setLoading(false);
          }
          setRefreshKey((k) => k + 1);
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
