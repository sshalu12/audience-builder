import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createConversation, listConversations } from "../api/client";
import type { Conversation } from "../types";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function ConversationsPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await listConversations();
      setConversations(response.conversations);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load conversations");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createNew() {
    const response = await createConversation();
    navigate(`/conversations/${response.conversation.id}`);
  }

  return (
    <div className="page-stack">
      <div className="page-header">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>Conversations</h1>
        </div>
        <button className="button" onClick={createNew}>
          New Audience
        </button>
      </div>

      {loading && <p>Loading conversations...</p>}
      {error && <p className="error">{error}</p>}

      <div className="conversation-grid">
        {conversations.map((conversation) => (
          <Link key={conversation.id} to={`/conversations/${conversation.id}`} className="conversation-card">
            <div className="conversation-card-header">
              <h2>{conversation.title ?? "Untitled audience"}</h2>
              <span className={`status ${conversation.status.toLowerCase()}`}>{conversation.status}</span>
            </div>
            <p>{conversation.audiencePlan?.summary ?? "No audience plan yet."}</p>
            {conversation.audiencePlan?.estimatedMin && conversation.audiencePlan.estimatedMax && (
              <strong>
                {conversation.audiencePlan.estimatedMin.toLocaleString()} -{" "}
                {conversation.audiencePlan.estimatedMax.toLocaleString()} reachable
              </strong>
            )}
            <footer>
              <span>{conversation._count?.messages ?? 0} messages</span>
              <span>Updated {formatDate(conversation.updatedAt)}</span>
            </footer>
          </Link>
        ))}
      </div>

      {!loading && conversations.length === 0 && (
        <div className="empty-state">
          <h2>No conversations yet</h2>
          <p>Create your first audience and try: “fitness enthusiasts aged 25-44 with premium shopping habits”.</p>
          <button className="button" onClick={createNew}>
            Start Building
          </button>
        </div>
      )}
    </div>
  );
}
