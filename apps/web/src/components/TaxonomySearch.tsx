import { useState } from "react";
import { searchTaxonomy } from "../api/client";
import type { TaxonomySignal } from "../types";

export function TaxonomySearch({ onAdd }: { onAdd: (signalId: string) => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [signals, setSignals] = useState<TaxonomySignal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runSearch() {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const response = await searchTaxonomy(query.trim());
      setSignals(response.signals.slice(0, 8));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="taxonomy-search">
    
      {error && <p className="error">{error}</p>}
      {signals.length > 0 && (
        <div className="search-results">
          {signals.map((signal) => (
            <div key={signal.id} className="search-result">
              <div>
                <strong>{signal.name}</strong>
                <p>{signal.path}</p>
              </div>
              <button className="button ghost small" onClick={() => onAdd(signal.id)}>
                Add
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
