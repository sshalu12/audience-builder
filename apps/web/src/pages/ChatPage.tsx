import { FormEvent, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  approveConversation,
  estimateConversation,
  getConversation,
  removeSignal,
  sendMessage,
} from "../api/client";
import { SignalPanel } from "../components/SignalPanel";
import { useAuth } from "../context/AuthContext";
import type { Conversation, Message } from "../types";

function MessageBubble({ message }: { message: Message }) {
  return (
    <div className={`message ${message.role.toLowerCase()}`}>
      <div className="message-role">{message.role === "USER" ? "Planner" : "Assistant"}</div>
      <div className="message-content">{message.content}</div>
    </div>
  );
}

export function ChatPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const { id } = useParams<{ id: string }>();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  async function load() {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const response = await getConversation(id);
      setConversation(response.conversation);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load conversation");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation?.messages?.length]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (isAdmin || !id || !input.trim() || !conversation) return;

    const content = input.trim();
    const pendingMessageId = `pending-user-${Date.now()}`;
    const optimisticMessage: Message = {
      id: pendingMessageId,
      conversationId: id,
      role: "USER",
      content,
      createdAt: new Date().toISOString(),
    };

    setInput("");
    setSending(true);
    setError(null);
    setConversation((current) =>
      current
        ? {
            ...current,
            messages: [...(current.messages ?? []), optimisticMessage],
          }
        : current,
    );

    try {
      const response = await sendMessage(id, content);
      setConversation(response.conversation);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
      setInput(content);
      setConversation((current) =>
        current
          ? {
              ...current,
              messages: (current.messages ?? []).filter(
                (message) => message.id !== pendingMessageId,
              ),
            }
          : current,
      );
    } finally {
      setSending(false);
    }
  }

  async function approve() {
    if (!id) return;
    setSending(true);
    try {
      const response = await approveConversation(id);
      setConversation(response.conversation);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve audience");
    } finally {
      setSending(false);
    }
  }

  async function estimate() {
    if (!id) return;
    setSending(true);
    try {
      const response = await estimateConversation(id);
      setConversation(response.conversation);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to estimate audience");
    } finally {
      setSending(false);
    }
  }

  async function removeSelectedSignal(signalId: string) {
    if (!id) return;
    setSending(true);
    try {
      const response = await removeSignal(id, signalId);
      setConversation(response.conversation);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove signal");
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return <div className="centered">Loading conversation...</div>;
  }

  if (!conversation) {
    return <div className="centered">Conversation not found</div>;
  }

  const messages = conversation.messages ?? [];

  return (
    <div className="builder-layout">
      <section className="chat-panel">
        <div className="chat-header">
          <div>
            <p className="eyebrow">Conversation</p>
            <h1>{conversation.title ?? "New Audience"}</h1>
          </div>
          <span className={`status ${conversation.status.toLowerCase()}`}>{conversation.status}</span>
        </div>

        <div className="messages">
          {messages.length === 0 && (
            <div className="empty-state compact">
              <h2>Describe your audience</h2>
              <p>Try: “fitness enthusiasts aged 25-44 with premium shopping habits”.</p>
            </div>
          )}
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {sending && <div className="message assistant muted">Working on it...</div>}
          <div ref={bottomRef} />
        </div>

        {error && <p className="error">{error}</p>}

        {isAdmin ? (
          <p className="muted"></p>
        ) : (
          <form className="composer" onSubmit={submit}>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Describe the audience or refine it, e.g. remove premium apparel, make it broader, approve this audience..."
              rows={3}
            />
            <button className="button" disabled={sending || !input.trim()}>
              Send
            </button>
          </form>
        )}
      </section>

      <SignalPanel
        plan={conversation.audiencePlan}
        onApprove={approve}
        onEstimate={estimate}
        onRemoveSignal={removeSelectedSignal}
        approving={sending}
        readOnly={isAdmin}
      />
    </div>
  );
}
