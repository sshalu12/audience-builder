import { FormEvent, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (user) {
    return <Navigate to="/conversations" replace />;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await login(email, password);
      navigate("/conversations");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <section className="login-card">
        <h1>Chat-Based Audience Builder</h1>
        <p>
          Sign in as a planner or admin to create AI-assisted advertising audiences from natural language briefs.
        </p>

        <form onSubmit={submit}>
          <label>
            Email
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" />
          </label>
          <label>
            Password
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="button full" disabled={loading}>
            {loading ? "Signing in..." : "Sign In"}
          </button>
          <p className="auth-switch">
            Don&apos;t have an account? <Link to="/register">Create account</Link>
          </p>
        </form>

      </section>
    </div>
  );
}
