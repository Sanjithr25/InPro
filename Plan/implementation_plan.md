# Implementation Plan: Core Execution Engine Abstraction

## Goal Description
The core execution engine must serve as a universal, recursive abstraction. At its foundation, an `Agent` uses our Claude Agent SDK wrapper to execute skills using available tools. A `Task` is simply an orchestration layer that takes one or more Agents and treats them as "sub-agents" to accomplish a goal. A `Task Group` (or Schedule) is a higher-order orchestrator that triggers multiple Tasks.

This creates a fractal "Tree of Workflows" pattern where every node in the execution graph, regardless of depth, ultimately relies on the exact same underlying SDK abstraction.

### The Fractal Execution Model
1.  **Node Level 0 (The Base):** The `Claude Agent SDK Wrapper`. It handles the prompt, LLM API communication, state/memory tracking, and tool execution.
2.  **Node Level 1 (The Agent):** An instance of the wrapper configured with a specific persona (Skill), a specific Model, and a subset of allowed hands (Tools).
3.  **Node Level 2 (The Task):** A runtime orchestrator. It receives an objective, spins up the selected Level 1 Agents dynamically, and orchestrates them. To the system, the Task operates like a higher-level "Manager Agent".
4.  **Node Level 3 (The Task Group / Schedule):** The root orchestrator. It fires on a trigger (cron, webhook), and sequentially or chronologically spawns Level 2 Tasks.

## Proposed Changes

### 1. `Core Execution Engine` Package
The heart of the system will be built around a single foundational interface that everything implements: `IExecutableNode`.

#### [NEW] `src/engine/IExecutableNode.ts`
Defines the base contract for any entity that can be executed in the tree.
*   `execute(context: ExecutionContext): Promise<ExecutionResult>`
*   `abort()`
*   `getStatus(): ExecutionStatus`

#### [NEW] `src/engine/ClaudeAgentWrapper.ts`
The lowest-level implementation of `IExecutableNode`.
*   Wraps the official Claude SDK.
*   Responsible for parsing the `markdown` skill file into system prompts.
*   Manages the direct conversational loop (Prompt -> Claude -> Tool Call -> Claude -> Result).

#### [NEW] `src/engine/AgentNode.ts`
Implements `IExecutableNode`.
*   A configuration wrapper around `ClaudeAgentWrapper`.
*   **State:** Holds the specific Agent's ID, its allowed `Tool` definitions, its assigned LLM Model, and its System Prompt (Skill).
*   When `execute()` is called, it initializes the `ClaudeAgentWrapper` with this state and runs it.

#### [NEW] `src/engine/TaskNode.ts`
Implements `IExecutableNode`.
*   **State:** Holds the Task description and an array of `AgentNode` instances (the sub-agents).
*   **Execution Logic:** 
    *   If there are multiple agents, it either runs them sequentially (Agent A's output becomes Agent B's input) or acts as a router.
    *   Crucially, because `AgentNode` implements `IExecutableNode`, the `TaskNode` just loops through its children calling `.execute(sharedContext)`.

#### [NEW] `src/engine/TaskGroupNode.ts` (Schedule Engine)
Implements `IExecutableNode`.
*   **State:** Trigger condition and an array of `TaskNode` instances.
*   **Execution Logic:** Iterates over its child tasks and calls `.execute()`. Emits overall progress events.

### 2. `Shared Context & Memory` Component
Because this is a tree, data needs to flow down and back up.

#### [NEW] `src/engine/ExecutionContext.ts`
The JSON-serializable state object passed down explicitly during an `.execute()` call. Must never contain class instances or DB connections to ensure safe Redis queueing.
*   **Input Data:** The payload to act upon (e.g., initial payload from a webhook trigger, or the explicit output result from the preceding Agent/Task in a sequence).
*   **Safety Limits:** Tracks `currentDepth` and `totalSteps`. Enforces a hard `MAX_DEPTH` circuit breaker to prevent infinite loops in the DAG.
*   **Isolation:** Agents and Tasks are strictly isolated. They do not share a global long-term memory pool during execution. If Task 2 needs data from Task 1, the Engine explicitly passes Task 1's `ExecutionResult` directly into Task 2's `ExecutionContext.InputData`.
*   **Event Emitters:** For streaming UI logs (e.g., `emit('step_completed', data)`).

### 3. `Engine Safety & Resilience` Component
*   **Queue Hydration:** When a worker pops a job from Redis, it must re-hydrate the raw JSON state back into the appropriate `AgentNode` or `TaskNode` class before calling `.execute()`.
*   **Idempotent Resumes:** Before a Node begins execution, it checks the database for a `completed` status on its `parent_run_id`. If found, it skips execution and safely returns the existing output, allowing pipelines to resume after partial tool failures.

#### [NEW] `src/engine/ToolRegistry.ts`
Tools are defined globally in the platform.
*   The `ToolRegistry` holds the actual execution logic code for every tool (e.g., `search_web`, `fetch_api`, `read_file`).
*   When an `AgentNode` is instantiated, it checks the DB for which tools it is allowed to use, fetches their schemas from the `ToolRegistry`, and passes *only* those schemas down to the `ClaudeAgentWrapper`.

## Verification Plan

### Automated Tests
*   **Unit Tests for `ClaudeAgentWrapper`**: Mock the official Claude SDK. Verify it correctly formats system prompts and correctly parses tool-call requests.
*   **Integration Tests for the Tree**:
    *   Define a mock `TaskGroup` -> containing two `Tasks` -> containing three `Agents`.
    *   Trigger the `TaskGroup`. Assert that `.execute()` propagates perfectly down the tree, and the `ExecutionContext` accumulates the results correctly back up to the root.

### Manual Verification
*   We will run a "Dry Run" from the conceptual UI where we trigger a compound Task. We should see the console logs recursively stepping down into the Agent executions and back out gracefully.
