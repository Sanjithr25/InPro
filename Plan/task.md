# Implementation Task List: AI Workflow Platform

Based on the architectural production guide, here is the structured roadmap for building the system.

## Phase 1: Foundation & The Unified Engine
- [ ] Initialize frontend repository (React/Next.js).
- [ ] Initialize backend repository (Node.js/Express or NestJS).
- [ ] Setup PostgreSQL database and initial migrations.
- [ ] Implement `LLM Settings` CRUD API and Frontend (Page 6).
- [ ] Implement `Agent Management` CRUD API and Frontend (Page 1).
- [ ] **Engine:** Define the `IExecutableNode` interface.
- [ ] **Engine:** Build `ClaudeAgentWrapper`, the base execution core.
- [ ] **Engine:** Build `AgentNode` implementing `IExecutableNode`.
- [ ] Wire up the "Dry Run" functionality on Page 1 to test basic Agent LLM connectivity.

## Phase 2: The Tooling System
- [ ] Implement `Tool Management` CRUD API and Frontend (Page 2).
- [ ] Design the dynamic configuration injection system for Tools (Secrets, Keys).
- [ ] Build the `ToolRegistry` and actual tool execution implementations.
- [ ] Update `AgentNode` and `ClaudeAgentWrapper` to dynamically parse and provide allowed tools.
- [ ] Verify agent-to-tool handoff logic via Dry Run.

## Phase 3: Orchestration & Tasks (The Middle Node)
- [ ] Implement `Task Management` CRUD API and Frontend (Page 3).
- [ ] Implement the prompt/logic to auto-generate workflows based on Task Descriptions.
- [ ] **Engine:** Build `TaskNode` implementing `IExecutableNode`, treating `AgentNode`s as sub-agents.
- [ ] Create UI to allow users to edit/reorder LLM-generated workflow steps.
- [ ] Test End-to-End: Dry Run an entire sequential compound Task synchronously.

## Phase 4: Asynchronous Execution, Schedules & Groups (The Root Node)
- [ ] Setup Redis and message queue infrastructure (e.g., BullMQ).
- [ ] Refactor engine entry point to dispatch `IExecutableNode` execution to the Redis queue instead of synchronous immediate execution.
- [ ] Create standalone backend Worker instances to consume from the Redis queue.
- [ ] Implement the `Scheduler Management` CRUD API and Frontend (Page 4).
- [ ] **Engine:** Build `TaskGroupNode` (Schedule) implementing `IExecutableNode`.
- [ ] Build the Scheduler Daemon to interpret Cron/Intervals and trigger Root Nodes to the queue.

## Phase 5: Event Streams & Observability
- [ ] Build the linear `ExecutionContext` object that flows down the execution tree and explicitly passes outputs to the next sequential node.
- [ ] Implement `Run History` API and Frontend (Page 5).
- [ ] Build telemetry emitters in the `IExecutableNode` hierarchy to stream token usage, latency, and status logs back to PostgreSQL/Redis.
- [ ] Setup WebSockets or polling on the frontend to display live execution streams.

## Phase 6: Polish
- [ ] Complete UI styling and error boundary handling.
- [ ] Create extensive seeded data for ease of onboarding.
- [ ] Conduct end-to-end load testing on deep nested workflows.
