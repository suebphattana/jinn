"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

interface Employee {
  name: string;
  role?: string;
  [key: string]: unknown;
}

interface ChatInputProps {
  disabled: boolean;
  onSend: (message: string) => void;
  onNewSession: () => void;
  onStatusRequest: () => void;
}

export function ChatInput({
  disabled,
  onSend,
  onNewSession,
  onStatusRequest,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load employees for @mention
  useEffect(() => {
    api
      .getOrg()
      .then((data) => {
        const emps = (data as Record<string, unknown>).employees;
        if (Array.isArray(emps)) {
          setEmployees(emps as Employee[]);
        }
      })
      .catch(() => {});
  }, []);

  const handleMentionSelect = useCallback(
    (name: string) => {
      // Replace the @partial with @name
      const atIdx = value.lastIndexOf("@");
      if (atIdx !== -1) {
        const before = value.slice(0, atIdx);
        setValue(before + "@" + name + " ");
      }
      setShowMentions(false);
      textareaRef.current?.focus();
    },
    [value]
  );

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setValue(val);

    // Check for @mention
    const atIdx = val.lastIndexOf("@");
    if (atIdx !== -1) {
      const afterAt = val.slice(atIdx + 1);
      // Only show if we're right after @ with no space yet (or partial name)
      if (!afterAt.includes(" ") && !afterAt.includes("\n")) {
        setMentionFilter(afterAt.toLowerCase());
        setShowMentions(true);
        return;
      }
    }
    setShowMentions(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleSubmit() {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;

    // Handle commands
    if (trimmed === "/new") {
      setValue("");
      onNewSession();
      return;
    }
    if (trimmed === "/status") {
      setValue("");
      onStatusRequest();
      return;
    }

    setValue("");
    setShowMentions(false);
    onSend(trimmed);
  }

  const filteredEmployees = employees.filter((e) =>
    e.name.toLowerCase().includes(mentionFilter)
  );

  return (
    <div className="relative border-t border-neutral-200 bg-white p-4">
      {/* Mention autocomplete */}
      {showMentions && filteredEmployees.length > 0 && (
        <div className="absolute bottom-full left-4 right-4 mb-1 bg-white border border-neutral-200 rounded-lg shadow-lg max-h-40 overflow-y-auto z-10">
          {filteredEmployees.slice(0, 8).map((emp) => (
            <button
              key={emp.name}
              onClick={() => handleMentionSelect(emp.name)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition-colors flex items-center gap-2"
            >
              <span className="text-blue-600 font-mono text-xs">@</span>
              <span className="font-medium">{emp.name}</span>
              {emp.role && (
                <span className="text-xs text-neutral-400">{emp.role}</span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={
            disabled
              ? "Waiting for response..."
              : "Type a message... (Enter to send, Shift+Enter for newline)"
          }
          rows={1}
          className="flex-1 resize-none rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ minHeight: "40px", maxHeight: "120px" }}
          onInput={(e) => {
            const target = e.target as HTMLTextAreaElement;
            target.style.height = "40px";
            target.style.height = Math.min(target.scrollHeight, 120) + "px";
          }}
        />
        <button
          onClick={handleSubmit}
          disabled={disabled || !value.trim()}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {disabled ? (
            <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            "Send"
          )}
        </button>
      </div>
      <div className="mt-1 flex gap-3 text-[10px] text-neutral-400">
        <span>/new - new chat</span>
        <span>/status - session info</span>
        <span>@name - mention employee</span>
      </div>
    </div>
  );
}
