import type { AudiencePlan, RecommendedSignal } from "../types";

function formatNumber(value?: number | null) {
  if (value === undefined || value === null) return "-";
  return new Intl.NumberFormat("en-US").format(value);
}

function SourceBadge({ source }: { source: RecommendedSignal["source"] }) {
  return <span className="source-badge">{source.replace(/_/g, " ")}</span>;
}

export function SignalPanel({
  plan,
  onApprove,
  onEstimate,
  onRemoveSignal,
  approving,
}: {
  plan?: AudiencePlan | null;
  onApprove: () => void;
  onEstimate: () => void;
  onRemoveSignal: (signalId: string) => void;
  approving: boolean;
}) 
{
  if (!plan) {
    return (
      <aside className="side-panel empty-panel">
        <h2>Audience Plan</h2>
        <p>Start by describing who you want to reach. The assistant will recommend taxonomy-backed signals here.</p>
      </aside>
    );
  }

  const signals = plan.selectedSignals ?? [];

  return (
    <aside className="side-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Audience Plan</p>
          <h2>{plan.audienceName ?? "Draft Audience"}</h2>
        </div>
        <span className={`status ${plan.status.toLowerCase()}`}>{plan.status}</span>
      </div>

      {plan.summary && <p className="summary">{plan.summary}</p>}

      <section>
        <h3>Selected Signals</h3>
        <div className="signal-list">
          {signals.length === 0 && <p className="muted">No selected signals yet.</p>}
          {signals.map((signal) => (
            <article key={signal.id} className="signal-card">
              <div className="signal-card-header">
                <strong>{signal.name}</strong>
                <SourceBadge source={signal.source} />
              </div>
              {signal.path && <p className="path">{signal.path}</p>}
              <p>{signal.rationale}</p>
              <div className="signal-actions">
                <span>Confidence {Math.round(signal.confidence * 100)}%</span>
                <button className="button ghost small" onClick={() => onRemoveSignal(signal.id)}>
                  Remove
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="estimate-card">
        <h3>Audience Estimate</h3>
        {plan.estimatedMin && plan.estimatedMax ? (
          <>
            <div className="estimate-number">
              {formatNumber(plan.estimatedMin)} - {formatNumber(plan.estimatedMax)}
            </div>
            <p>Confidence: {Math.round((plan.confidence ?? 0) * 100)}%</p>
            {plan.estimate?.methodology && <p className="muted">{plan.estimate.methodology}</p>}
          </>
        ) : (
          <p className="muted">Estimate appears after approval or when you request sizing.</p>
        )}
      </section>

      <div className="panel-actions">
        <button className="button secondary" onClick={onEstimate} disabled={approving || signals.length === 0}>
          Estimate
        </button>
        <button className="button" onClick={onApprove} disabled={approving || signals.length === 0}>
          Approve Audience
        </button>
      </div>
    </aside>
  );
}
