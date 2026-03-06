"use client";
import { useEffect, useRef } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
  engine?: string;
  model?: string;
}

interface ChatMessagesProps {
  messages: Message[];
  loading: boolean;
}

function renderContent(text: string) {
  const parts: React.ReactNode[] = [];
  const lines = text.split("\n");
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let codeKey = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("```")) {
      if (inCodeBlock) {
        parts.push(
          <pre
            key={`code-${codeKey++}`}
            className="bg-neutral-900 text-neutral-100 rounded-lg p-3 my-2 text-xs font-mono overflow-x-auto"
          >
            {codeLines.join("\n")}
          </pre>
        );
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Inline formatting
    const formatted = formatInline(line, i);
    parts.push(formatted);
  }

  // Close unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    parts.push(
      <pre
        key={`code-${codeKey}`}
        className="bg-neutral-900 text-neutral-100 rounded-lg p-3 my-2 text-xs font-mono overflow-x-auto"
      >
        {codeLines.join("\n")}
      </pre>
    );
  }

  return parts;
}

function formatInline(line: string, key: number): React.ReactNode {
  if (line.trim() === "") {
    return <br key={`br-${key}`} />;
  }

  // Split by inline code, bold, and plain text
  const segments: React.ReactNode[] = [];
  let remaining = line;
  let segKey = 0;

  while (remaining.length > 0) {
    // Inline code
    const codeMatch = remaining.match(/^(.*?)`([^`]+)`/);
    if (codeMatch) {
      if (codeMatch[1]) {
        segments.push(...parseBold(codeMatch[1], `${key}-${segKey++}`));
      }
      segments.push(
        <code
          key={`ic-${key}-${segKey++}`}
          className="bg-neutral-200 text-neutral-800 px-1 py-0.5 rounded text-xs font-mono"
        >
          {codeMatch[2]}
        </code>
      );
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // No more inline code, handle bold in remaining
    segments.push(...parseBold(remaining, `${key}-${segKey++}`));
    break;
  }

  return (
    <p key={`p-${key}`} className="my-0.5">
      {segments}
    </p>
  );
}

function parseBold(text: string, key: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const boldRegex = /\*\*([^*]+)\*\*/g;
  let lastIndex = 0;
  let match;

  while ((match = boldRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <strong key={`b-${key}-${match.index}`}>{match[1]}</strong>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

export function ChatMessages({ messages, loading }: ChatMessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  if (messages.length === 0 && !loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-lg font-medium text-neutral-400">
            Start a conversation
          </p>
          <p className="text-sm text-neutral-300 mt-1">
            Send a message or use /new to begin
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.map((msg, i) => (
        <div
          key={i}
          className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
        >
          <div
            className={`max-w-[75%] rounded-xl px-4 py-3 ${
              msg.role === "user"
                ? "bg-blue-600 text-white"
                : "bg-neutral-100 text-neutral-900 border border-neutral-200"
            }`}
          >
            <div className="text-sm leading-relaxed">
              {renderContent(msg.content)}
            </div>
            {msg.role === "assistant" && (msg.engine || msg.model) && (
              <div className="mt-2 flex gap-1">
                {msg.engine && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-500">
                    {msg.engine}
                  </span>
                )}
                {msg.model && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-500">
                    {msg.model}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
      {loading && (
        <div className="flex justify-start">
          <div className="bg-neutral-100 border border-neutral-200 rounded-xl px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-neutral-500">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-neutral-400 animate-pulse" />
              Thinking...
            </div>
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
