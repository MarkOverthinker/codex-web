export type AutomationInput = {
  name: string;
  prompt: string;
  workingDir: string | null;
  time: string;
  timeZone: string;
  model: string;
  reasoningEffort: string;
  sandbox: "workspace-write" | "danger-full-access";
  enabled: boolean;
};

export type Automation = AutomationInput & {
  id: string;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
};

export type AutomationRun = {
  id: string;
  automationId: string;
  name: string;
  trigger: "scheduled" | "manual";
  scheduledAt: string;
  createdAt: string;
  conversationId: string | null;
  jobId: string | null;
  status: string;
  error: string | null;
  snapshot: AutomationInput;
};
