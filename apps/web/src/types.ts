export type Role = "ADMIN" | "PLANNER";
export type ConversationStatus = "DRAFT" | "APPROVED";
export type AudienceStatus = "DRAFT" | "APPROVED";
export type MessageRole = "USER" | "ASSISTANT" | "SYSTEM";
export type SignalSource =
  | "LOCATION"
  | "TRANSACTION"
  | "CONSUMER_GRAPH_FIELD"
  | "CONSUMER_GRAPH_VALUE";

export type User = {
  id: string;
  email: string;
  name?: string | null;
  role: Role;
  createdAt?: string;
};

export type Message = {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  metadata?: unknown;
  createdAt: string;
};

export type RecommendedSignal = {
  id: string;
  source: SignalSource;
  name: string;
  path?: string | null;
  confidence: number;
  rationale: string;
};

export type AudienceEstimate = {
  estimatedMin: number;
  estimatedMax: number;
  confidence: number;
  methodology: string;
  assumptions: string[];
};

export type AudiencePlan = {
  id: string;
  conversationId: string;
  brief: string;
  audienceName?: string | null;
  summary?: string | null;
  intent?: unknown;
  selectedSignals: RecommendedSignal[];
  estimatedMin?: number | null;
  estimatedMax?: number | null;
  confidence?: number | null;
  estimate?: AudienceEstimate | null;
  status: AudienceStatus;
  createdAt: string;
  updatedAt: string;
};

export type Conversation = {
  id: string;
  title?: string | null;
  status: ConversationStatus;
  userId: string;
  user?: User;
  messages?: Message[];
  audiencePlan?: AudiencePlan | null;
  _count?: { messages: number };
  createdAt: string;
  updatedAt: string;
};

export type TaxonomySignal = {
  id: string;
  source: SignalSource;
  name: string;
  description?: string | null;
  path?: string | null;
  score?: number;
  fieldName?: string | null;
  fieldValue?: string | null;
};
