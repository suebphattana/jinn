"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Session {
  id: string;
  employee?: string;
  status?: string;
  lastActivity?: string;
  createdAt?: string;
  [key: string]: unknown;
}

interface ChatSidebarProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  refreshKey: number;
}

export function ChatSidebar({
  selectedId,
  onSelect,
  onNewChat,
  refreshKey,
}: ChatSidebarProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .getSessions()
      .then((data) => {
        const filtered = (data as Session[]).filter(
          (s) => s.source === "web" || !s.source
        );
        filtered.sort((a, b) => {
          const ta = a.lastActivity || a.createdAt || "";
          const tb = b.lastActivity || b.createdAt || "";
          return tb.localeCompare(ta);
        });
        setSessions(filtered);
      })
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  function formatTime(dateStr?: string): string {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    return `${diffD}d ago`;
  }

  return (
    <div className="flex flex-col h-full border-r border-neutral-200 bg-neutral-50">
      <div className="p-3 border-b border-neutral-200">
        <button
          onClick={onNewChat}
          className="w-full px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
        >
          + New Chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <p className="px-4 py-6 text-xs text-neutral-400 text-center">
            Loading...
          </p>
        ) : sessions.length === 0 ? (
          <p className="px-4 py-6 text-xs text-neutral-400 text-center">
            No conversations yet
          </p>
        ) : (
          sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => onSelect(session.id)}
              className={`w-full text-left px-4 py-3 border-b border-neutral-100 transition-colors ${
                selectedId === session.id
                  ? "bg-blue-50 border-l-2 border-l-blue-500"
                  : "hover:bg-neutral-100"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-neutral-800 truncate">
                  {session.employee || "Jimmy"}
                </span>
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full ${
                    session.status === "running"
                      ? "bg-green-500"
                      : session.status === "completed"
                        ? "bg-neutral-300"
                        : session.status === "error"
                          ? "bg-red-400"
                          : "bg-neutral-300"
                  }`}
                />
              </div>
              <p className="text-xs text-neutral-400 mt-0.5">
                {formatTime(session.lastActivity || session.createdAt)}
              </p>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
