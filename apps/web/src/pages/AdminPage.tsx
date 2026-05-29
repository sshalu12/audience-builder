import { useEffect, useState } from "react";
import { adminConversations, adminTaxonomy, adminUsers } from "../api/client";
import type { Conversation, TaxonomySignal, User } from "../types";

type AdminUser = User & { _count: { conversations: number } };

export function AdminPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [taxonomy, setTaxonomy] = useState<TaxonomySignal[]>([]);
  const [counts, setCounts] = useState<Array<{ source: string; _count: { source: number } }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [userResponse, conversationResponse, taxonomyResponse] = await Promise.all([
          adminUsers(),
          adminConversations(),
          adminTaxonomy(),
        ]);
        setUsers(userResponse.users);
        setConversations(conversationResponse.conversations);
        setTaxonomy(taxonomyResponse.taxonomy);
        setCounts(taxonomyResponse.counts);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load admin data");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  return (
    <div className="page-stack">
      <div className="page-header">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Workspace Overview</h1>
        </div>
      </div>

      {loading && <p>Loading admin data...</p>}
      {error && <p className="error">{error}</p>}

      <section className="admin-grid">
        <article className="admin-card">
          <h2>Users</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Conversations</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>{user.email}</td>
                    <td>{user.role}</td>
                    <td>{user._count.conversations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>

        <article className="admin-card">
          <h2>Taxonomy Counts</h2>
          <div className="count-list">
            {counts.map((count) => (
              <div key={count.source}>
                <strong>{count.source.replace(/_/g, " ")}</strong>
                <span>{count._count.source}</span>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="admin-card">
        <h2>Approved Audiences</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>User</th>
                <th>Status</th>
                <th>Estimate</th>
              </tr>
            </thead>
            <tbody>
              {conversations.slice(0, 10).map((conversation) => (
                <tr key={conversation.id}>
                  <td>{conversation.title ?? "Untitled"}</td>
                  <td>{conversation.user?.email}</td>
                  <td>{conversation.status}</td>
                  <td>
                    {conversation.audiencePlan?.estimatedMin
                      ? `${conversation.audiencePlan.estimatedMin.toLocaleString()} - ${conversation.audiencePlan.estimatedMax?.toLocaleString()}`
                      : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-card">
        <h2>Taxonomy Preview</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Source</th>
                <th>Path</th>
              </tr>
            </thead>
            <tbody>
              {taxonomy.slice(0, 100).map((signal) => (
                <tr key={signal.id}>
                  <td>{signal.name}</td>
                  <td>{signal.source}</td>
                  <td>{signal.path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
