# AI Workflow Platform — Production Guide & Architectural Breakdown

This guide outlines the system design, bounded contexts, technical trade-offs, and implementation approach for the AI Workflow Platform.

## 1. Executive Summary & Domain Vision
The system is an orchestrator of AI capabilities, translating abstract user goals into deterministic, scheduled multi-agent workflows. It bridges the gap between conversational LLM runtimes and traditional enterprise job scheduling.

**Core Trade-off Emphasized:** Flexibility vs. Predictability. The system allows infinite flexibility in LLM prompts and tools, but demands strict predictability in workflow execution, scheduling, and error boundaries.

## 2. Bounded Contexts (Domain-Driven Design)
Based on the provided specification, the domain cleanly decomposes into four primary Bounded Contexts:

### A. Agent & Tool Context (The "Capabilities" Domain)
*   **Responsibility:** Defining what the system *can* do.
*   **Aggregates:** `Agent` (Identity, Prompt/Skill, Model), `Tool` (Integration points, credentials).
*   **Dependencies:** LLM Configuration Service.

### B. Task & Workflow Context (The "Orchestration" Domain)
*   **Responsibility:** Defining the *sequence* of what will be done.
*   **Aggregates:** `TaskTemplate`, `WorkflowDefinition` (DAG or sequential steps).
*   **Dependencies:** Depends on Agent/Tool context for validation, but owns its own execution graphs.

### C. Execution & Scheduling Context (The "Runtime" Domain)
*   **Responsibility:** Delivering on the workflows at scale, asynchronously.
*   **Aggregates:** `JobSchedule` (Cron, Interval, Webhook), `TaskRun` (Execution state, logs, metrics).
*   **Tech Strategy:** Heavy reliance on stateless workers, Redis queues (BullMQ/Celery), and containerized isolation for security.

### D. Settings & Integrations Context (The "Foundation" Domain)
*   **Responsibility:** Centralizing secrets, LLM provider routing, and global preferences.
*   **Aggregates:** `LLMProviderConfig`, `APIKeys`.

---

## 3. High-Level Architectural Decisions (ADRs)

### ADR-001: Async Task Execution via Message Queues (Redis/BullMQ)
*   **Context:** AI tasks take unpredictable amounts of time (streaming LLMs, external API calls, rate limits). HTTP request-response cycles will timeout.
*   **Decision:** All executions are submitted to a Redis-backed queue. The API Server only returns a `RunID`. Background workers pick up tasks.
*   **Consequences (Trade-offs):** 
    *   *Gains:* High availability, scalability, failure containment, ability to retry.
    *   *Costs:* Accidental complexity in the UI. The frontend must adopt polling or WebSockets to reflect status in the Run History page rather than waiting for an HTTP 200.

### ADR-002: Polyglot Persistence Strategy
*   **Context:** The platform manages relational config (Task definitions), unstructured context/memory, and high-throughput events.
*   **Decision:** 
    *   **PostgreSQL:** Relational source of truth for Agents, Tools, Schedules, and Run History metadata.
    *   **Milvus:** Vector DB for long-term Agent memory and contextual embeddings.
    *   **Redis:** For transient state, pub/sub event streaming, and execution coordination.
*   **Consequences (Trade-offs):** 
    *   *Gains:* Purpose-built tools for distinct data shapes.
    *   *Costs:* Operational overhead of managing three different database technologies.

### ADR-003: Stateless Agent Runtime
*   **Context:** Agents need to act upon workflows. Stateful agents consume memory linearly and are hard to scale horizontally.
*   **Decision:** The Agent Runtime is completely stateless. The `Context Manager` intercepts calls and hydrates the agent's context from Postgres/Milvus immediately before execution.
*   **Consequences (Trade-offs):**
    *   *Gains:* Workers can be killed and restarted safely. We can autoscale based on queue depth.
    *   *Costs:* Slight latency penalty fetching context for every execution step.

---

## 4. Implementation Strategy & Roadmap

This project should be tackled primarily via the **Walking Skeleton** pattern—building a thin, complete slice of the system first.

### Phase 1: The Core Loop (Walking Skeleton)
**Goal:** Create an Agent and execute a dry run.
*   Database schema for Agents and LLM Settings.
*   Basic Node.js API (CRUD for Agents).
*   Integration with ONE LLM provider (e.g., OpenAI).
*   React scaffolding (Page 1 & Page 6).

### Phase 2: The Tooling Layer
**Goal:** Give the agent hands.
*   Tool definition schema and CRUD (Page 2).
*   `ToolExecutor` integration into the `AgentRuntime`.
*   Testing basic web search or API pinging tools.

### Phase 3: Orchestration & Workflows
**Goal:** Chain tasks together.
*   Task and Workflow configuration (Page 3).
*   LLM-assisted step generation logic.
*   Basic sequential `WorkflowEngine` running in the backend.

### Phase 4: Production Runtime & Scheduling
**Goal:** Reliability at scale.
*   Introduce Redis queue and distinct Worker processes.
*   Scheduler daemon (Cron, interval parsing) (Page 4).
*   Docker runner integration (if isolation is required as per notes).

### Phase 5: Observability & Run History
**Goal:** What happened and when?
*   Granular logging pipeline emitting to PostgreSQL.
*   Streaming UI updates on Page 5 (Run History).
*   Token usage and duration metrics.

---
*Created by: Software Architect Agent*
