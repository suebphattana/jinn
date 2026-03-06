"use client";

interface Session {
  id: string;
  engine: string;
  source: string;
  employee: string | null;
  status: "idle" | "running" | "error";
  lastActivity: string;
}

const statusStyles: Record<string, string> = {
  idle: "bg-green-500",
  running: "bg-yellow-500",
  error: "bg-red-500",
};

const statusLabel: Record<string, string> = {
  idle: "Idle",
  running: "Running",
  error: "Error",
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function engineIcon(engine: string): string {
  if (engine === "claude") return "C";
  if (engine === "codex") return "X";
  return "?";
}

export function SessionList({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (sessions.length === 0) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white px-5 py-12 text-center text-sm text-neutral-400">
        No sessions found
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-100 text-left text-xs font-medium uppercase tracking-wide text-neutral-400">
            <th className="px-4 py-3">Engine</th>
            <th className="px-4 py-3">Source</th>
            <th className="px-4 py-3">Employee</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Last Activity</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {sessions.map((s) => (
            <tr
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={`cursor-pointer transition-colors ${
                selectedId === s.id
                  ? "bg-blue-50"
                  : "hover:bg-neutral-50"
              }`}
            >
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-neutral-100 text-xs font-mono font-medium text-neutral-600">
                    {engineIcon(s.engine)}
                  </span>
                  <span className="capitalize">{s.engine}</span>
                </div>
              </td>
              <td className="px-4 py-3 text-neutral-600">{s.source}</td>
              <td className="px-4 py-3 text-neutral-600">
                {s.employee || "Jimmy"}
              </td>
              <td className="px-4 py-3">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={`inline-block w-2 h-2 rounded-full ${statusStyles[s.status] || "bg-neutral-300"}`}
                  />
                  <span className="text-neutral-700">
                    {statusLabel[s.status] || s.status}
                  </span>
                </span>
              </td>
              <td className="px-4 py-3 text-neutral-500 text-xs">
                {relativeTime(s.lastActivity)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
