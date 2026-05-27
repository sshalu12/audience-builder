import type { Conversation, TaxonomySignal, User } from "../types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000/api";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function getToken() {
  return window.localStorage.getItem("audience_builder_token");
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(response.status, body?.error ?? "Request failed");
  }

  return response.json() as Promise<T>;
}

export async function login(email: string, password: string) {
  return apiFetch<{ token: string; user: User }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function register(input: {
  name?: string;
  email: string;
  password: string;
}) {
  return apiFetch<{ token: string; user: User }>("/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function me() {
  return apiFetch<{ user: User }>("/auth/me");
}

export async function listConversations() {
  return apiFetch<{ conversations: Conversation[] }>("/conversations");
}

export async function createConversation(title?: string) {
  return apiFetch<{ conversation: Conversation }>("/conversations", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

export async function getConversation(id: string) {
  return apiFetch<{ conversation: Conversation }>(`/conversations/${id}`);
}

export async function sendMessage(conversationId: string, content: string) {
  return apiFetch<{ conversation: Conversation }>(`/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

export async function approveConversation(conversationId: string) {
  return apiFetch<{ conversation: Conversation }>(`/conversations/${conversationId}/approve`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function estimateConversation(conversationId: string) {
  return apiFetch<{ conversation: Conversation }>(`/conversations/${conversationId}/estimate`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function removeSignal(conversationId: string, signalId: string) {
  return apiFetch<{ conversation: Conversation }>(`/conversations/${conversationId}/signals/remove`, {
    method: "POST",
    body: JSON.stringify({ signalId }),
  });
}

export async function addSignal(conversationId: string, signalId: string) {
  return apiFetch<{ conversation: Conversation }>(`/conversations/${conversationId}/signals/add`, {
    method: "POST",
    body: JSON.stringify({ signalId }),
  });
}

export async function searchTaxonomy(q: string) {
  return apiFetch<{ signals: TaxonomySignal[] }>(`/taxonomy/search?q=${encodeURIComponent(q)}`);
}

export async function adminUsers() {
  return apiFetch<{ users: Array<User & { _count: { conversations: number } }> }>("/admin/users");
}

export async function adminConversations() {
  return apiFetch<{ conversations: Conversation[] }>("/admin/conversations");
}

export async function adminTaxonomy() {
  return apiFetch<{
    taxonomy: TaxonomySignal[];
    counts: Array<{ source: string; _count: { source: number } }>;
  }>("/admin/taxonomy");
}
