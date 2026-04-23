import { useEffect, useState, useRef, useCallback } from "react";
import { Send, Trash2, Loader2, MessageSquare, Cpu, Wrench } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { useI18n } from "@/i18n";

interface ToolActivity {
  tool: string;
  args: string;
  status: "running" | "done" | "error";
  duration?: number;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolActivity?: ToolActivity[];
  thinking?: string;
}

export default function ChatPage() {
  const { t } = useI18n();
  
  // Load messages from localStorage on mount
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const stored = localStorage.getItem("hermes-chat-messages");
      if (stored) {
        const parsed = JSON.parse(stored);
        // Clean up any stale thinking states from localStorage
        return parsed.map((msg: ChatMessage) => ({
          ...msg,
          thinking: undefined,
          toolActivity: msg.toolActivity?.map(activity => 
            activity.status === "running" ? { ...activity, status: "done" as const } : activity
          ),
        }));
      }
    } catch (e) {
      console.error("Failed to load chat messages from localStorage:", e);
    }
    return [];
  });
  
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelInfo, setModelInfo] = useState<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const assistantIndexRef = useRef<number>(-1);

  // Save messages to localStorage whenever they change
  useEffect(() => {
    try {
      localStorage.setItem("hermes-chat-messages", JSON.stringify(messages));
    } catch (e) {
      console.error("Failed to save chat messages to localStorage:", e);
    }
  }, [messages]);

  // Fetch current model info on mount
  useEffect(() => {
    api
      .getModelInfo()
      .then((resp) => {
        const model = resp.model || resp.capabilities?.model_family || "";
        const provider = resp.provider || "";
        if (model) {
          setModelInfo(provider ? `${provider}/${model}` : model);
        }
      })
      .catch(() => {});
  }, []);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    // Clear error state
    setError(null);
    setIsLoading(true);

    // Use functional update to get latest messages length and set assistant index
    setMessages((prev) => {
      // We're adding 2 messages: user (at prev.length) and assistant (at prev.length + 1)
      assistantIndexRef.current = prev.length + 1;
      return [
        ...prev,
        { role: "user", content: text },
        { role: "assistant", content: "" },
      ];
    });
    setInput("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Get session token from window
      const token = (window as any).__HERMES_SESSION_TOKEN__;
      if (!token) {
        throw new Error("Session token not available");
      }

      const response = await fetch("/api/chat?session_id=web", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: text }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(`${response.status}: ${errText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("ReadableStream not supported");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";
      let currentEventType = "";
      const assistantIndex = assistantIndexRef.current;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events from buffer
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEventType = line.slice(7);
            continue;
          }
          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6);
            if (!dataStr.trim()) continue;

            let parsed: any;
            try {
              parsed = JSON.parse(dataStr);
            } catch {
              continue; // JSON parse error, skip
            }

            if (parsed.delta !== undefined && currentEventType === "message") {
              fullContent += parsed.delta;
              setMessages((prev) => {
                const updated = [...prev];
                if (updated[assistantIndex]) {
                  updated[assistantIndex] = {
                    ...updated[assistantIndex],
                    content: fullContent,
                    thinking: undefined,
                  };
                }
                return updated;
              });
            }

            if (currentEventType === "tool_start" && parsed.tool) {
              setMessages((prev) => {
                const updated = [...prev];
                const msg = updated[assistantIndex];
                if (msg) {
                  const activities = [...(msg.toolActivity || [])];
                  activities.push({ tool: parsed.tool, args: parsed.args || "", status: "running" });
                  updated[assistantIndex] = { ...msg, toolActivity: activities };
                }
                return updated;
              });
            }

            if (currentEventType === "tool_complete" && parsed.tool) {
              setMessages((prev) => {
                const updated = [...prev];
                const msg = updated[assistantIndex];
                if (msg?.toolActivity) {
                  const activities = [...msg.toolActivity];
                  for (let j = activities.length - 1; j >= 0; j--) {
                    if (activities[j].tool === parsed.tool && activities[j].status === "running") {
                      activities[j] = {
                        ...activities[j],
                        status: parsed.is_error ? "error" : "done",
                        duration: parsed.duration,
                      };
                      break;
                    }
                  }
                  updated[assistantIndex] = { ...msg, toolActivity: activities };
                }
                return updated;
              });
            }

            if (currentEventType === "thinking" && parsed.text) {
              setMessages((prev) => {
                const updated = [...prev];
                if (updated[assistantIndex]) {
                  updated[assistantIndex] = { ...updated[assistantIndex], thinking: parsed.text };
                }
                return updated;
              });
            }

            if (currentEventType === "done") {
              if (parsed.content) {
                fullContent = parsed.content;
              }
              // Clear thinking state on done
              setMessages((prev) => {
                const updated = [...prev];
                if (updated[assistantIndex]) {
                  updated[assistantIndex] = {
                    ...updated[assistantIndex],
                    content: fullContent || parsed.content || "",
                    thinking: undefined,
                  };
                }
                return updated;
              });
            }

            if (parsed.message && currentEventType === "error") {
              throw new Error(parsed.message);
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        // User cancelled, keep partial content
        return;
      }
      console.error("Chat error:", err);
      setError(err.message || "Failed to send message");
      // Remove the empty assistant message on error
      setMessages((prev) => {
        const updated = [...prev];
        const idx = assistantIndexRef.current;
        if (idx >= 0 && updated[idx]?.content === "") {
          updated.splice(idx, 1);
        }
        return updated;
      });
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = async () => {
    try {
      const token = (window as any).__HERMES_SESSION_TOKEN__;
      if (token) {
        await fetch("/api/chat/session?session_id=web", {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch {
      // ignore
    }
    setMessages([]);
    setError(null);
  };

  const cancelRequest = () => {
    abortRef.current?.abort();
  };

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] sm:h-[calc(100vh-8rem)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-base font-semibold">{t.chat.title}</h1>
          {messages.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              {messages.length} {t.chat.messages}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {modelInfo && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Cpu className="h-3.5 w-3.5" />
              <span className="font-mono text-[11px]">{modelInfo}</span>
            </div>
          )}
          {isLoading && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={cancelRequest}
            >
              {t.chat.cancel}
            </Button>
          )}
          {messages.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={clearChat}
              disabled={isLoading}
            >
              <Trash2 className="h-3 w-3 mr-1" />
              {t.chat.clear}
            </Button>
          )}
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto pr-2 space-y-4 min-h-0">
        {messages.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <MessageSquare className="h-12 w-12 mb-4 opacity-20" />
            <p className="text-sm font-medium">{t.chat.empty}</p>
            <p className="text-xs mt-1 text-muted-foreground/60">
              {t.chat.emptyHint}
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] sm:max-w-[75%] rounded-lg px-4 py-3 ${
                msg.role === "user"
                  ? "bg-primary/15 text-foreground"
                  : "bg-secondary/40 border border-border text-foreground"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`text-[10px] font-semibold uppercase tracking-wider ${
                    msg.role === "user"
                      ? "text-primary/70"
                      : "text-success/70"
                  }`}
                >
                  {msg.role === "user" ? t.chat.you : t.chat.assistant}
                </span>
              </div>
              {/* Tool activity display */}
              {msg.toolActivity && msg.toolActivity.length > 0 && (
                <div className="mb-2 border-l-2 border-border pl-2 space-y-0.5">
                  {msg.toolActivity.map((activity, j) => (
                    <div key={j} className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono">
                      {activity.status === "running" ? (
                        <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                      ) : activity.status === "error" ? (
                        <span className="text-destructive shrink-0">✗</span>
                      ) : (
                        <Wrench className="h-3 w-3 text-success shrink-0" />
                      )}
                      <span className="truncate">
                        {activity.tool}{activity.args ? `: ${activity.args}` : ""}
                      </span>
                      {activity.duration != null && activity.status !== "running" && (
                        <span className="text-muted-foreground/50 shrink-0">({activity.duration}s)</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {msg.content ? (
                msg.role === "user" ? (
                  <p className="text-sm whitespace-pre-wrap leading-relaxed">
                    {msg.content}
                  </p>
                ) : (
                  <Markdown content={msg.content} />
                )
              ) : msg.thinking ? (
                <div className="flex items-center gap-2 py-1">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">
                    {msg.thinking}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 py-1">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">
                    {t.chat.thinking}
                  </span>
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Error banner */}
      {error && (
        <div className="mt-2 p-2 border border-destructive/30 bg-destructive/10 text-destructive text-xs rounded">
          {error}
        </div>
      )}

      {/* Input area */}
      <div className="mt-4 flex gap-2">
        <div className="flex-1 relative">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t.chat.placeholder}
            disabled={isLoading}
            rows={1}
            className="w-full resize-none rounded-lg border border-border bg-background/50 px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 min-h-[42px] max-h-[120px]"
            style={{
              height: "auto",
              minHeight: "42px",
              maxHeight: "120px",
            }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = "auto";
              target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
            }}
          />
        </div>
        <Button
          size="icon"
          className="h-[42px] w-[42px] shrink-0"
          disabled={!input.trim() || isLoading}
          onClick={sendMessage}
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>

      {/* Keyboard hint */}
      <p className="text-[10px] text-muted-foreground/40 mt-1.5 text-center">
        {t.chat.enterToSend}
      </p>
    </div>
  );
}
